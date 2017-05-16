"use strict";

var assert = require('assert')
var bitcoin = require('bitcoinjs-lib')
var discoverAddresses = require('./network').discoverAddresses
var fetchTransactions = require('./network').fetchTransactions
var fetchUnspents = require('./network').fetchUnspents
var TxGraph = require('bitcoin-tx-graph')
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

function Wallet(externalAccount, internalAccount, networkName, done, unspentsDone, balanceDone) {
  if(arguments.length === 0) return this;
  if(unspentsDone == null) {
    unspentsDone = function() {
      // no-op
    }
  }
  if(balanceDone == null) {
    balanceDone = function() {
      // no-op
    }
  }

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
  this.txGraph = new TxGraph()

  var that = this

  discoverAddresses(this.api, this.externalAccount, this.internalAccount,
    function(err, addresses, changeAddresses, balance, unspentAddresses) {
      if(err) {
        return doneError(err);
      }

      that.addresses = addresses
      that.changeAddresses = changeAddresses

      balanceDone(null, balance)
      fetchUnspents(that.api, unspentAddresses, unspentsDone)

      var addresses = addresses.concat(changeAddresses)
      fetchTransactions(that.api, addresses, function(err, txs, metadata) {
        if(err) return done(err);

        txs.forEach(function(tx) { that.txGraph.addTx(tx) })

        var feesAndValues = that.txGraph.calculateFeesAndValues(addresses, bitcoin.networks[that.networkName])
        that.txMetadata = mergeMetadata(feesAndValues, metadata)

        done(null, that)
      })
    })

  function doneError(err) {
    done(err)
    unspentsDone(err)
    balanceDone(err)
  }
}

Wallet.prototype.getBalance = function(minConf) {
  minConf = minConf || 0

  var network = bitcoin.networks[this.networkName]
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var utxos = getCandidateOutputs(this.txGraph.getAllNodes(), this.txMetadata, network, myAddresses, minConf)

  return utxos.reduce(function(balance, unspent) {
    return balance + unspent.value
  }, 0)
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

// param: `txObj` or
// `[{tx: txObj1, confirmations: n1, timestamp: t1}, {tx: txObj2, confirmations: n2, timestamp: t2}]`
Wallet.prototype.processTx = function(txs) {
  if(!Array.isArray(txs)) {
    txs = [{tx: txs}]
  }

  var foundUsed = true
  while(foundUsed) {
    foundUsed = addToAddresses.bind(this)(this.getNextAddress(), this.getNextChangeAddress())
  }

  txs.forEach(function(obj) {
    var tx = obj.tx
    this.txGraph.addTx(tx)

    var id = tx.getId()
    this.txMetadata[id] = this.txMetadata[id] || { confirmations: null }
    if(obj.confirmations != null) {
      this.txMetadata[id].confirmations = obj.confirmations
    }
    if(obj.timestamp != null) {
      this.txMetadata[id].timestamp = obj.timestamp
    }
  }, this)

  //FIXME: make me more effecient
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var feesAndValues = this.txGraph.calculateFeesAndValues(myAddresses, bitcoin.networks[this.networkName])
  this.txMetadata = mergeMetadata(feesAndValues, this.txMetadata)

  function addToAddresses(nextAddress, nextChangeAddress) {
    for(var i=0; i<txs.length; i++) {
      var tx = txs[i].tx
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
}

Wallet.prototype.createTx = function(to, value, fee, minConf, unspents) {
  var network = bitcoin.networks[this.networkName]
  validate.preCreateTx(to, value, network)

  if(minConf == null) {
    minConf = 1
  }

  var utxos = null
  if(unspents != null) {
    validate.utxos(unspents)
    utxos = unspents.filter(function(unspent) {
      return unspent.confirmations >= minConf
    })
  } else {
    var myAddresses = this.addresses.concat(this.changeAddresses)
    utxos = getCandidateOutputs(this.txGraph.getAllNodes(), this.txMetadata, network, myAddresses, minConf)
  }

  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value
  })

  var accum = 0
  var subTotal = value
  var addresses = []

  var builder = new bitcoin.TransactionBuilder()
  builder.addOutput(to, value)

  var that = this
  utxos.some(function(unspent) {
    builder.addInput(unspent.txId, unspent.vout)
    addresses.push(unspent.address)

    var estimatedFee
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

  validate.postCreateTx(subTotal, accum, this.getBalance(0))

  addresses.forEach(function(address, i) {
    builder.sign(i, that.getPrivateKeyForAddress(address))
  })

  return builder.build()
}

Wallet.prototype.estimateFees = function(to, value, feeRates) {
  var network = bitcoin.networks[this.networkName]

  var minConf = 1
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var utxos = getCandidateOutputs(this.txGraph.getAllNodes(), this.txMetadata, network, myAddresses, minConf)
  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value
  })

  var subTotal = value
  var fees = []

  for (var i = 0; i < feeRates.length; i++) {
    var builder = new bitcoin.TransactionBuilder()
    builder.addOutput(to, value)

    var accum = 0
    var that = this
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
  this.api.transactions.propagate(tx.toHex(), function(err){
    if(err) return done(err);

    that.processTx(tx)
    done()
  })
}

function getCandidateOutputs(allNodes, metadata, network, myAddresses, minConf) {
  var confirmedNodes = allNodes.filter(function(n) {
    var meta = metadata[n.id]
    return meta && meta.confirmations >= minConf
  })

  return confirmedNodes.reduce(function(unspentOutputs, node) {
    node.tx.outs.forEach(function(out, i) {
      var address = bitcoin.Address.fromOutputScript(out.script, network).toString()
      if(myAddresses.indexOf(address) >= 0 && node.nextNodes[i] == null) {
        unspentOutputs.push({
          txId: node.id,
          address: address,
          value: out.value,
          vout: i
        })
      }
    })

    return unspentOutputs
  }, [])
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
  var txGraph = this.txGraph
  var metadata = this.txMetadata

  var nodes = txGraph.getAllNodes().filter(function(n) {
    return n.tx != null && metadata[n.id].value != null
  }).sort(function(a, b) {
    var confDiff = metadata[a.id].confirmations - metadata[b.id].confirmations
    if(confDiff !== 0) {
      return confDiff
    }

    return txGraph.compareNodes(a, b)
  })

  return nodes.map(function(n) {
    return n.tx
  })
}

Wallet.prototype.serialize = function() {
  var txs = this.txGraph.getAllNodes().reduce(function(memo, node) {
    var tx = node.tx
    if(tx == null) return memo;

    memo.push(tx.toHex())
    return memo
  }, [])

  return JSON.stringify({
    externalAccount: this.externalAccount.toBase58(),
    internalAccount: this.internalAccount.toBase58(),
    addressIndex: this.addresses.length,
    changeAddressIndex: this.changeAddresses.length,
    networkName: this.networkName,
    txs: txs,
    txMetadata: this.txMetadata
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
  wallet.txMetadata = deserialized.txMetadata

  wallet.txGraph = new TxGraph()
  deserialized.txs.forEach(function(hex) {
    wallet.txGraph.addTx(bitcoin.Transaction.fromHex(hex))
  })

  return wallet
}


function mergeMetadata(feesAndValues, metadata) {
  for(var id in metadata) {
    var fee = feesAndValues[id].fee
    if(fee != null) metadata[id].fee = fee

    var value = feesAndValues[id].value
    if(value < 0) value += fee
    if(value != null) metadata[id].value = value
  }

  return metadata
}

function deriveAddresses(account, untilId) {
  var addresses = []
  for(var i=0; i<untilId; i++) {
    addresses.push(account.derive(i).getAddress().toString())
  }
  return addresses
}

module.exports = Wallet

