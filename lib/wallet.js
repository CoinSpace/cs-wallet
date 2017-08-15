"use strict";

var assert = require('assert')
var bitcoin = require('bitcoinjs-lib')
var discoverAddresses = require('./network').discoverAddresses
var fetchTransactions = require('./network').fetchTransactions
var fetchUnspents = require('./network').fetchUnspents
var validate = require('./validator')
var API = require('cs-insight');

function getAPI(network) {
  var baseURL = null;
  var proxy = process.env.INSIGHT_PROXY_URL;

  if ((network === 'bitcoin' || network === 'testnet'))  {
    baseURL = process.env.API_BTC_URL;
  } else if (network === 'litecoin') {
    bitcoin.networks['litecoin'].dustThreshold = 54600;
    baseURL = process.env.API_LTC_URL;
  }

  return new API(network, proxy, baseURL)
}

function Wallet(options) {
  if(arguments.length === 0) return this;

  var externalAccount = options.externalAccount
  var internalAccount = options.internalAccount
  var networkName = options.networkName
  var done = options.done
  var txDone = options.txDone ? options.txDone : function() {}

  try {
    if(typeof externalAccount === 'string') {
      this.externalAccount = bitcoin.HDNode.fromBase58(externalAccount)
    } else {
      this.externalAccount = externalAccount
    }

    if(typeof internalAccount === 'string') {
      this.internalAccount = bitcoin.HDNode.fromBase58(internalAccount)
    } else {
      this.internalAccount = internalAccount
    }

    assert(this.externalAccount != null, 'externalAccount cannot be null')
    assert(this.internalAccount != null, 'internalAccount cannot be null')
  } catch(err) {
    return doneError(err)
  }

  this.networkName = networkName
  this.api = getAPI(networkName)
  this.balance = 0
  this.historyTxs = []
  this.unspents = []
  this.minConf = 1

  var that = this

  discoverAddresses(this.api, this.externalAccount, this.internalAccount,
    function(err, addresses, changeAddresses, balance, unspentAddresses, txIds) {
      if(err) {
        return doneError(err);
      }

      that.addresses = addresses
      that.changeAddresses = changeAddresses
      that.balance = balance

      var allAddresses = addresses.concat(changeAddresses)

      fetchUnspents(that.api, unspentAddresses, function(err, utxos) {
        if(err) return done(err);
        that.unspents = utxos;
        done(null, that)

        fetchTransactions(that.api, allAddresses, txIds, function(err, historyTxs) {
          if(err) return txDone(err);
          that.historyTxs = historyTxs
          txDone(null, that)
        })
      })
    })

  function doneError(err) {
    done(err)
    txDone(err)
  }
}

Wallet.prototype.getBalance = function() {
  return this.balance
}

Wallet.prototype.getNextChangeAddress = function() {
  return this.internalAccount.derive(this.changeAddresses.length).getAddress().toString()
}

Wallet.prototype.getNextAddress = function() {
  return this.externalAccount.derive(this.addresses.length).getAddress().toString()
}

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  var index
  if((index = this.addresses.indexOf(address)) > -1) {
    return this.externalAccount.derive(index).privKey
  } else if((index = this.changeAddresses.indexOf(address)) > -1) {
    return this.internalAccount.derive(index).privKey
  } else {
    throw new Error('Unknown address. Make sure the address is from the keychain and has been generated.')
  }
}

Wallet.prototype.createTx = function(to, value, fee, minConf, unspents) {
  var network = bitcoin.networks[this.networkName]
  validate.preCreateTx(to, value, network)

  if(minConf == null) {
    minConf = this.minConf
  }

  var utxos = null
  if(unspents != null) {
    validate.utxos(unspents)
    utxos = unspents.filter(function(unspent) {
      return unspent.confirmations >= minConf
    })
  } else {
    utxos = getCandidateOutputs(this.unspents, minConf)
  }

  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value
  })

  var accum = 0
  var estimatedFee = 0
  var subTotal = value
  var addresses = []

  var builder = new bitcoin.TransactionBuilder()
  builder.addOutput(to, value)

  var that = this
  utxos.some(function(unspent) {
    builder.addInput(unspent.txId, unspent.vout)
    addresses.push(unspent.address)

    if(fee == undefined) {
      estimatedFee = estimateFeePadChangeOutput(builder.buildIncomplete(), network, network.feePerKb)
    } else {
      estimatedFee = fee
    }

    accum += unspent.value
    subTotal = value + estimatedFee
    if (accum >= subTotal) {
      var change = accum - subTotal

      if (change > network.dustThreshold) {
        builder.addOutput(that.getNextChangeAddress(), change)
      }

      return true
    }
  })

  validate.postCreateTx(value, accum, this.getBalance(), estimatedFee)

  addresses.forEach(function(address, i) {
    builder.sign(i, that.getPrivateKeyForAddress(address))
  })

  return builder.build()
}

Wallet.prototype.estimateFees = function(to, value, feeRates) {
  var network = bitcoin.networks[this.networkName]

  console.log('this.minConf', this);
  var minConf = this.minConf
  var utxos = getCandidateOutputs(this.unspents, minConf)
  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value
  })

  var subTotal = value
  var fees = []

  for (var i = 0; i < feeRates.length; i++) {
    var builder = new bitcoin.TransactionBuilder()
    builder.addOutput(to, value)

    var accum = 0
    var estimatedFee = 0
    utxos.some(function(unspent) {
      builder.addInput(unspent.txId, unspent.vout)

      estimatedFee = estimateFeePadChangeOutput(builder.buildIncomplete(), network, feeRates[i])

      accum += unspent.value
      subTotal = value + estimatedFee

      if (accum >= subTotal) {
        return true
      }
    })

    fees.push(estimatedFee)
  }

  return fees
}

Wallet.prototype.sendTx = function(tx, done) {
  var that = this
  this.api.transactions.propagate(tx.toHex(), function(err) {
    if(err) return done(err);
    that.processTx(tx, done)
  })
}

Wallet.prototype.processTx = function(tx, done) {
  var that = this
  var foundUsed = true
  while(foundUsed) {
    foundUsed = addToAddresses.bind(this)(this.getNextAddress(), this.getNextChangeAddress())
  }

  var allAddresses = that.addresses.concat(that.changeAddresses)

  fetchTransactions(that.api, allAddresses, [tx.getId()], function(err, historyTxs) {
    if(err) return done(err);

    var historyTx = historyTxs[0]

    that.balance += (historyTx.amount - historyTx.fees)
    historyTx.vin.forEach(function(input) {
      that.unspents = that.unspents.filter(function(unspent) {
        return unspent.txId !== input.txid
      })
    })
    that.historyTxs.unshift(historyTx)
    done(null, historyTx)
  })

  function addToAddresses(nextAddress, nextChangeAddress) {
    var found = tx.outs.some(function(out){
      var address = bitcoin.Address.fromOutputScript(out.script, bitcoin.networks[this.networkName]).toString()
      if(nextChangeAddress === address) {
        this.changeAddresses.push(address)
        return true
      } else if(nextAddress === address) {
        this.addresses.push(address)
        return true
      }
    }, this)

    if(found) return true
  }
}

function getCandidateOutputs(unspents, minConf) {
  return unspents.filter(function(unspent) {
    return unspent.confirmations >= minConf
  })
}

function estimateFeePadChangeOutput(tx, network, feePerKb) {
  var tmpTx = tx.clone()
  var tmpAddress = bitcoin.Address.fromOutputScript(tx.outs[0].script, network)
  tmpTx.addOutput(tmpAddress, network.dustSoftThreshold || 0)

  var baseFee = feePerKb / 1000
  var byteSize = tmpTx.ins.length * 148 + tmpTx.outs.length * 34 + 10

  var fee = baseFee * byteSize
  if (network.dustSoftThreshold === undefined) return fee

  tmpTx.outs.forEach(function (e) {
    if (e.value < network.dustSoftThreshold) {
      fee += feePerKb
    }
  })
  return fee
}

Wallet.prototype.getTransactionHistory = function() {
  return this.historyTxs.sort(function(a, b) {
    return a.confirmations - b.confirmations
  })
}

Wallet.prototype.serialize = function() {

  return JSON.stringify({
    externalAccount: this.externalAccount.toBase58(),
    internalAccount: this.internalAccount.toBase58(),
    addressIndex: this.addresses.length,
    changeAddressIndex: this.changeAddresses.length,
    networkName: this.networkName,
    balance: this.getBalance(),
    unspents: this.unspents,
    historyTxs: this.historyTxs,
    minConf: this.minConf
  })
}

Wallet.deserialize = function(json) {
  var wallet = new Wallet()
  var deserialized = JSON.parse(json)
  wallet.externalAccount = bitcoin.HDNode.fromBase58(deserialized.externalAccount)
  wallet.internalAccount = bitcoin.HDNode.fromBase58(deserialized.internalAccount)
  wallet.addresses = deriveAddresses(wallet.externalAccount, deserialized.addressIndex)
  wallet.changeAddresses = deriveAddresses(wallet.internalAccount, deserialized.changeAddressIndex)
  wallet.networkName = deserialized.networkName
  wallet.api = getAPI(deserialized.networkName)
  wallet.balance = deserialized.balance
  wallet.unspents = deserialized.unspents
  wallet.historyTxs = deserialized.historyTxs
  wallet.minConf = deserialized.minConf

  return wallet
}

function deriveAddresses(account, untilId) {
  var addresses = []
  for(var i=0; i<untilId; i++) {
    addresses.push(account.derive(i).getAddress().toString())
  }
  return addresses
}

module.exports = Wallet

