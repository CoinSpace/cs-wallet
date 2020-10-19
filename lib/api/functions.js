'use strict';

var bip32utils = require('@coinspace/bip32-utils');
var Big = require('big.js');
var bchaddr = require('bchaddrjs');

function discoverAddresses(wallet, externalAccount, internalAccount, addressFunction) {
  var promises = [externalAccount, internalAccount].map(function(account) {
    var deriveFunction = function(parent, index) {
      return parent.deriveChild(index);
    };
    var iterator = new bip32utils.Chain(account, 0, addressFunction, deriveFunction);
    return discoverUsedAddresses(iterator, wallet.api);
  });

  return Promise.all(promises).then(function(results) {
    var txIds = results[0].txIds.concat(results[1].txIds);
    txIds = txIds.filter(function(item, i) {
      return txIds.indexOf(item) === i;
    });

    return {
      addresses: results[0].addresses,
      changeAddresses: results[1].addresses,
      balance: btcToSatoshi(results[0].balance + results[1].balance),
      unspentAddresses: results[0].unspentAddresses.concat(results[1].unspentAddresses),
      txIds: txIds
    };
  });
}

function discoverUsedAddresses(iterator, api) {
  var usedAddresses = [];
  var unspentAddresses = [];
  var txIds = [];
  var balance = 0;

  return new Promise(function(resolve, reject) {
    bip32utils.discovery(iterator, 3, 10, function(addresses, callback) {
      usedAddresses = usedAddresses.concat(addresses);
      api.addresses.summary(addresses).then(function(results) {
        txIds = txIds.concat(results.reduce(function(memo, result) {
          return memo.concat(result.txIds);
        }, []));
        balance += results.reduce(function(total, address) {
          if (address.balance > 0) {
            unspentAddresses.push(address.address);
          }
          return total += address.balance;
        }, 0);
        var areUsed = results.reduce(function(obj, result) {
          obj[result.address] = result.txCount > 0;
          return obj;
        }, {});
        callback(undefined, areUsed);
      }).catch(callback);
    }, function(err, k) {
      if (err) return reject(err);
      console.info('Discovered ' + k + ' addresses');
      return resolve({
        addresses: usedAddresses.slice(0, k),
        balance: balance,
        unspentAddresses: unspentAddresses,
        txIds: txIds
      });
    });
  });
}

function fetchTransactions(wallet, addresses, txIds) {
  return wallet.api.transactions.get(txIds).then(function(txs) {
    var feeAddresses = wallet.csFeeAddresses || [];
    txs = txs.map(function(tx) {
      tx = parseTx(tx, wallet.networkName);

      var inputValue = tx.ins.reduce(function(memo, input) {
        if (addresses.indexOf(input.addr) !== -1) {
          return memo + input.amount;
        }
        return memo;
      }, 0);

      var outputValue = tx.outs.reduce(function(memo, output) {
        if (feeAddresses.indexOf(output.addr) !== -1) {
          tx.fee += output.amount;
        }
        if (addresses.indexOf(output.addr) !== -1) {
          return memo + output.amount;
        }
        return memo;
      }, 0);

      tx.amount = outputValue - inputValue;
      if (tx.amount < 0) {
        tx.amount += tx.fee;
      }
      tx.isIncoming = tx.amount > 0;
      return tx;
    });

    return txs;
  });
}

function parseTx(tx, networkName) {
  return {
    id: tx.txId,
    timestamp: tx.timestamp * 1000,
    confirmations: tx.confirmations,
    fee: btcToSatoshi(tx.fees),
    ins: tx.vin.map(function(input) {
      return {
        address: toAddress(networkName, input.addr),
        amount: input.valueSat,
        txid: input.txid,
        vout: input.vout,
        addr: input.addr
      };
    }),
    outs: tx.vout.map(function(output) {
      var addr = output.scriptPubKey.addresses ? output.scriptPubKey.addresses[0] : null;
      return {
        address: toAddress(networkName, addr),
        amount: output.valueSat,
        vout: output.vout,
        addr: addr
      };
    }),
  };
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
  discoverAddresses: discoverAddresses,
  fetchTransactions: fetchTransactions,
  fetchUnspents: fetchUnspents
};
