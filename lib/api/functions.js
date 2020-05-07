'use strict';

var bip32utils = require('bip32-utils');
var Big = require('big.js');

function discoverAddresses(api, externalAccount, internalAccount, addressFunction) {
  var promises = [externalAccount, internalAccount].map(function(account) {
    var deriveFunction = function(parent, index) {
      return parent.deriveChild(index);
    };
    var iterator = new bip32utils.Chain(account, 0, addressFunction, deriveFunction);
    return discoverUsedAddresses(iterator, api);
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

function fetchTransactions(api, addresses, txIds, feeAddresses) {
  return api.transactions.get(txIds).then(function(txs) {
    feeAddresses = feeAddresses || [];
    txs.forEach(function(tx) {
      tx.fees = btcToSatoshi(tx.fees);

      var inputValue = tx.vin.reduce(function(memo, input) {
        if (addresses.indexOf(input.addr) >= 0) {
          return memo + input.valueSat;
        }
        return memo;
      }, 0);
      var outputValue = tx.vout.reduce(function(memo, output) {
        if (output.scriptPubKey.addresses && feeAddresses.indexOf(output.scriptPubKey.addresses[0]) !== -1) {
          tx.fees += output.valueSat;
        }
        if (output.scriptPubKey.addresses && addresses.indexOf(output.scriptPubKey.addresses[0]) >= 0) {
          return memo + output.valueSat;
        }
        return memo;
      }, 0);

      tx.amount = outputValue - inputValue;
      if (tx.amount < 0) {
        tx.amount += tx.fees;
      }
    });

    return txs;
  });
}

function btcToSatoshi(btc) {
  return parseInt(new Big(btc).times(100000000), 10);
}

function fetchUnspents(api, addresses) {
  return api.addresses.unspents(addresses);
}

module.exports = {
  discoverAddresses: discoverAddresses,
  fetchTransactions: fetchTransactions,
  fetchUnspents: fetchUnspents
};
