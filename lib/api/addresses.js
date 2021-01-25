'use strict';

const { batchGetRequest } = require('./utils');
const bitcoin = require('../bitcoin');

/**
 * check whether address(es) is correct from bitcoin point of view
 *
 * @private
 * @param addresses
 * @param network
 * @returns {Promise}
 */
function validateAddresses(addresses, network) {
  return new Promise((resolve, reject) => {
    const invalidAddresses = [].concat(addresses).filter((address) => {
      return !bitcoin.address.getAddressType(address, network);
    });

    if (invalidAddresses.length === 1) {
      reject(new Error(invalidAddresses[0] + ' is not a valid address'));
    } else if (invalidAddresses.length > 1) {
      reject(new Error(invalidAddresses.join(', ') + ' are not a valid address'));
    } else {
      resolve();
    }
  });
}

function Addresses(url, network) {
  this.url = url;
  this.network = network;
}

/**
 * returns summer about address(es)
 *
 * @param ids
 * @returns {axios.Promise}
 */
Addresses.prototype.summary = function(ids) {
  const self = this;

  return validateAddresses(ids, self.network)
    .then(() => {
      return batchGetRequest(self.url, 'addrs/', ids);
    })
    .then((data) => {
      return data.map((res) => {
        return {
          address: res.addrStr,
          balance: res.balance + res.unconfirmedBalance,
          txCount: res.txApperances + res.unconfirmedTxApperances,
          txIds: res.transactions,
        };
      });
    });
};

/**
 * returns unspent transactions of address(es)
 *
 * @param addresses
 * @param callback
 * @returns {axios.Promise}
 */
Addresses.prototype.unspents = function(addresses) {
  const self = this;

  addresses = [].concat(addresses);

  return validateAddresses(addresses, self.network)
    .then(() => {
      const params = addresses.map((id) => { return { id }; });
      return batchGetRequest(self.url, 'addrs/:id/utxo', params);
    })
    .then((utxs) => {
      utxs = utxs.map((tx) => {
        return {
          address: tx.address,
          type: bitcoin.address.getAddressType(tx.address, self.network),
          confirmations: tx.confirmations,
          txId: tx.txid,
          value: tx.satoshis,
          vout: tx.vout,
        };
      });
      return utxs;
    });
};

module.exports = Addresses;
