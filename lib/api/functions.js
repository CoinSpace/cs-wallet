'use strict';

const bip32utils = require('@coinspace/bip32-utils');
const Big = require('big.js');
const bchaddr = require('bchaddrjs');
const bitcoin = require('../bitcoin');

function discoverAddresses(wallet, externalAccount, internalAccount, addressFunction) {
  const promises = [externalAccount, internalAccount].map((account) => {
    const deriveFunction = function(parent, index) {
      return parent.deriveChild(index);
    };
    const iterator = new bip32utils.Chain(account, 0, addressFunction, deriveFunction);
    return discoverUsedAddresses(iterator, wallet.api);
  });

  return Promise.all(promises).then((results) => {
    let txIds = results[0].txIds.concat(results[1].txIds);
    txIds = txIds.filter((item, i) => {
      return txIds.indexOf(item) === i;
    });

    return {
      addresses: results[0].addresses,
      changeAddresses: results[1].addresses,
      balance: btcToSatoshi((results[0].balance + results[1].balance).toFixed(8)),
      unspentAddresses: results[0].unspentAddresses.concat(results[1].unspentAddresses),
      txIds,
    };
  });
}

function discoverUsedAddresses(iterator, api) {
  let usedAddresses = [];
  const unspentAddresses = [];
  let txIds = [];
  let balance = 0;

  return new Promise((resolve, reject) => {
    bip32utils.discovery(iterator, 3, 10, (addresses, callback) => {
      usedAddresses = usedAddresses.concat(addresses);
      api.addresses.summary(addresses).then((results) => {
        txIds = txIds.concat(results.reduce((memo, result) => {
          return memo.concat(result.txIds);
        }, []));
        balance += results.reduce((total, address) => {
          if (address.balance > 0) {
            unspentAddresses.push(address.address);
          }
          return total += address.balance;
        }, 0);
        const areUsed = results.reduce((obj, result) => {
          obj[result.address] = result.txCount > 0;
          return obj;
        }, {});
        callback(undefined, areUsed);
      }).catch(callback);
    }, (err, k) => {
      if (err) return reject(err);
      console.info('Discovered ' + k + ' addresses');
      return resolve({
        addresses: usedAddresses.slice(0, k),
        balance,
        unspentAddresses,
        txIds,
      });
    });
  });
}

function fetchTransactions(wallet, addresses, txIds) {
  return wallet.api.transactions.get(txIds).then((txs) => {
    return txs.map((tx) => {
      return parseTx(tx, wallet, addresses);
    });
  });
}

function parseTx(tx, wallet, addresses) {
  const csFeeAddresses = wallet.csFeeAddresses || [];
  let inputValue = 0;
  let outputValue = 0;
  let csFee = 0;
  let isRBF = false;
  let ins = 0;
  let outs = 0;
  tx = {
    id: tx.txId,
    timestamp: tx.timestamp * 1000,
    confirmations: tx.confirmations,
    fee: btcToSatoshi(tx.fees),
    ins: tx.vin.map((input) => {
      ins++;
      if (addresses.indexOf(input.addr) !== -1) {
        inputValue += input.valueSat;
      }
      if (wallet.replaceByFeeEnabled && !isRBF && tx.confirmations === 0) {
        isRBF = input.sequence < bitcoin.Transaction.DEFAULT_SEQUENCE - 1;
      }
      return {
        address: toAddress(wallet.networkName, input.addr),
        amount: input.valueSat,
        txid: input.txid,
        vout: input.vout,
        type: bitcoin.address.getAddressType(input.addr, wallet.network),
        addr: input.addr,
      };
    }),
    outs: tx.vout.map((output) => {
      outs++;
      const addr = output.scriptPubKey.addresses ? output.scriptPubKey.addresses[0] : null;
      if (csFeeAddresses.indexOf(addr) !== -1 && outs !== 1) {
        csFee += output.valueSat;
      }
      if (addresses.indexOf(addr) !== -1) {
        outputValue += output.valueSat;
      }
      return {
        address: toAddress(wallet.networkName, addr),
        amount: output.valueSat,
        vout: output.vout,
        type: bitcoin.address.getAddressType(addr, wallet.network),
        addr,
      };
    }),
  };
  tx.size = ins * 148 + outs * 34 + 10;
  tx.feePerByte = Math.ceil(tx.fee / tx.size);

  tx.csFee = csFee;
  tx.minerFee = tx.fee;
  tx.fee = tx.minerFee + tx.csFee;

  tx.amount = outputValue - inputValue;
  if (tx.amount < 0) {
    tx.amount += tx.fee;
  }
  tx.isIncoming = tx.amount > 0;
  tx.isRBF = isRBF && ((tx.feePerByte * wallet.replaceByFeeFactor) < wallet.network.maxFeePerByte);
  return tx;
}

function toAddress(networkName, address) {
  if (networkName !== 'bitcoincash') return address;
  try {
    address = bchaddr.toCashAddress(address).split(':')[1];
  // eslint-disable-next-line
  } catch (e) {};
  return address;
}

function btcToSatoshi(btc) {
  return parseInt(new Big(btc).times(100000000), 10);
}

function fetchUnspents(wallet, addresses) {
  return wallet.api.addresses.unspents(addresses);
}

module.exports = {
  discoverAddresses,
  fetchTransactions,
  fetchUnspents,
};
