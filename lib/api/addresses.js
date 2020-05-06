'use strict';

var batchGetRequest = require('./utils').batchGetRequest;
var bitcoin = require('../bitcoin');

/**
 * check whether address(es) is correct from bitcoin point of view
 *
 * @private
 * @param addresses
 * @param network
 * @returns {Promise}
 */
function validateAddresses(addresses, network) {
  return new Promise(function(resolve, reject) {
    var invalidAddresses = [].concat(addresses).filter(function(address) {
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
  var self = this;

  return validateAddresses(ids, self.network)
    .then(function() {
      return batchGetRequest(self.url, 'addrs/', ids);
    })
    .then(function(data) {
      return data.map(function(res) {
        return {
          address: res.addrStr,
          balance: res.balance + res.unconfirmedBalance,
          txCount: res.txApperances + res.unconfirmedTxApperances,
          txIds: res.transactions
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
  var self = this;

  addresses = [].concat(addresses);

  return validateAddresses(addresses, self.network)
    .then(function() {
      var params = addresses.map(function(id) { return {id: id}; });
      return batchGetRequest(self.url, 'addrs/:id/utxo', params);
    })
    .then(function(utxs) {
      utxs = utxs.map(function(tx) {
        return {
          address: tx.address,
          type: bitcoin.address.getAddressType(tx.address, self.network),
          confirmations: tx.confirmations,
          txId: tx.txid,
          value: tx.satoshis,
          vout: tx.vout
        };
      });
      return utxs;
    });
};

module.exports = Addresses;
