"use strict";

var bitcoin = require('bitcoinjs-lib')
var bip32utils = require('bip32-utils')
var async = require('async')
var Big = require('big.js')

function discoverAddressesForAccounts(api, externalAccount, internalAccount, callback) {
  var functions = [externalAccount, internalAccount].map(function(account) {
    var iterator = new bip32utils.Chain(account)
    return function(cb) { discoverUsedAddresses(iterator, api, cb) }
  })

  async.parallel(functions, function(err, results) {
    if(err) return callback(err);

    callback(null, results[0].addresses, results[1].addresses,
      btcToSatoshi(results[0].balance + results[1].balance),
      results[0].unspentAddresses.concat(results[1].unspentAddresses))
  })
}

function discoverUsedAddresses(iterator, api, done) {
  var usedAddresses = []
  var unspentAddresses = []
  var balance = 0

  bip32utils.discovery(iterator, 50, function(addresses, callback) {
    usedAddresses = usedAddresses.concat(addresses)

    api.addresses.summary(addresses, function(err, results) {
      if (err) return callback(err);

      balance += results.reduce(function(total, address) {
        if(address.balance > 0) {
          unspentAddresses.push(address.address)
        }
        return total += address.balance
      }, 0)

      callback(undefined, results.map(function(result) {
        return result.txCount > 0
      }))
    })
  }, function(err, k) {
    if (err) return done(err);

    console.info('Discovered ' + k + ' addresses')

    done(null, {
      addresses: usedAddresses.slice(0, k),
      balance: balance,
      unspentAddresses: unspentAddresses
    })
  })
}

function fetchTransactions(api, addresses, done) {
  api.addresses.transactions(addresses, function(err, transactions) {
    if(err) return done(err);

    var parsed = parseTransactions(transactions)

    api.transactions.get(getAdditionalTxIds(parsed.txs), function(err, transactions) {
      if(err) return done(err);

      parsed = parseTransactions(transactions, parsed)
      done(null, parsed.txs, parsed.metadata)
    })
  })
}

// TODO: get rid of this once cb-blocr is updated to return satoshi
function btcToSatoshi(btc) {
  return parseInt(new Big(btc).times(100000000), 10)
}

function fetchUnspents(api, addresses, done) {
  api.addresses.unspents(addresses, function(err, unspents) {
    if(err) return done(err);

    unspents.forEach(function(unspent){
      unspent.value = btcToSatoshi(unspent.value)
    })

    done(null, unspents)
  })
}

function parseTransactions(transactions, initialValue) {
  initialValue = initialValue || {txs: [], metadata: {}}
  return transactions.reduce(function(memo, t) {
    var tx = bitcoin.Transaction.fromHex(t.txHex)
    memo.txs.push(tx)
    memo.metadata[tx.getId()] = {
      confirmations: t.__confirmations,
      timestamp: t.__blockTimestamp
    }

    return memo
  }, initialValue)
}

function getAdditionalTxIds(txs) {
  var inputTxIds = txs.reduce(function(memo, tx) {
    tx.ins.forEach(function(input) {
      var hash = new Buffer(input.hash)
      Array.prototype.reverse.call(hash)
      memo[hash.toString('hex')] = true
    })
    return memo
  }, {})

  var txIds = txs.map(function(tx) { return tx.getId() })

  return Object.keys(inputTxIds).filter(function(id) {
    return txIds.indexOf(id) < 0
  })
}

module.exports = {
  discoverAddresses: discoverAddressesForAccounts,
  fetchTransactions: fetchTransactions,
  fetchUnspents: fetchUnspents
}