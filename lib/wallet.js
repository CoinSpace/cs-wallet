'use strict';

var assert = require('assert');
var bitcoin = require('bitcoinjs-lib');
var discoverAddresses = require('./network').discoverAddresses;
var fetchTransactions = require('./network').fetchTransactions;
var fetchUnspents = require('./network').fetchUnspents;
var validate = require('./validator');
var API = require('./api');
var _ = require('lodash');
var HDKey = require('hdkey');
var BigInteger = require('bigi');

bitcoin.networks = _.merge(bitcoin.networks, {
  bitcoin: {
    dustThreshold: 546,
    feePerKb: 10000
  },
  testnet: {
    dustThreshold: 546,
    feePerKb: 10000
  },
  litecoin: {
    dustThreshold: 54600,
    dustSoftThreshold: 100000,
    feePerKb: 100000
  }
});
bitcoin.networks.bitcoincash = bitcoin.networks.bitcoin;

function getAPI(network) {
  var baseURL = null;
  if ((network === 'bitcoin' || network === 'testnet')) {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_BTC_URL;
  } else if (network === 'bitcoincash') {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_BCH_URL;
  } else if (network === 'litecoin') {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_LTC_URL;
  }
  return new API(baseURL);
}

function Wallet(options) {
  if (arguments.length === 0) return this;

  var externalAccount = options.externalAccount;
  var internalAccount = options.internalAccount;
  var networkName = options.networkName;
  var network = bitcoin.networks[networkName];
  var done = options.done;
  var txDone = options.txDone ? options.txDone : function() {};

  try {
    if (typeof externalAccount === 'string') {
      this.externalAccount = HDKey.fromExtendedKey(externalAccount, network.bip32);
    } else {
      this.externalAccount = externalAccount;
    }

    if (typeof internalAccount === 'string') {
      this.internalAccount = HDKey.fromExtendedKey(internalAccount, network.bip32);
    } else {
      this.internalAccount = internalAccount;
    }

    assert(this.externalAccount != null, 'externalAccount cannot be null');
    assert(this.internalAccount != null, 'internalAccount cannot be null');
  } catch (err) {
    return doneError(err);
  }

  this.networkName = networkName;
  this.api = getAPI(networkName);
  this.balance = 0;
  this.historyTxs = [];
  this.unspents = [];
  this.minConf = options.minConf || 4;

  var that = this;
  var addressFunction = function(node) {
    return getAddress(node, networkName);
  };

  var txIds = [];
  var allAddresses = [];

  discoverAddresses(this.api, this.externalAccount, this.internalAccount, addressFunction).then(function(data) {
    that.addresses = data.addresses;
    that.changeAddresses = data.changeAddresses;
    that.balance = data.balance;
    txIds = data.txIds;
    allAddresses = that.addresses.concat(that.changeAddresses);
    return fetchUnspents(that.api, data.unspentAddresses).then(function(utxos) {
      that.unspents = utxos;
      done(null, that);
    });
  }).catch(done).then(function() {
    return fetchTransactions(that.api, allAddresses, txIds).then(function(historyTxs) {
      that.historyTxs = historyTxs;
      txDone(null, that);
    });
  }).catch(txDone);

  function doneError(err) {
    done(err);
    txDone(err);
  }
}

Wallet.bitcoin = bitcoin;

Wallet.prototype.getBalance = function() {
  return this.balance;
};

Wallet.prototype.getNextChangeAddress = function() {
  return getAddress(this.internalAccount.deriveChild(this.changeAddresses.length), this.networkName);
};

Wallet.prototype.getNextAddress = function() {
  return getAddress(this.externalAccount.deriveChild(this.addresses.length), this.networkName);
};

Wallet.prototype.exportPrivateKeys = function() {
  if (this.unspents.length === 0) return '';
  var that = this;
  var network = bitcoin.networks[this.networkName];
  var lines = ['address,privatekey'];
  var exported = {};
  that.unspents.forEach(function(unspent) {
    if (exported[unspent.address]) return false;
    exported[unspent.address] = true;
    lines.push(unspent.address + ',' + that.getPrivateKeyForAddress(unspent.address).toWIF(network));
  });
  return lines.join('\n');
};

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  var index;
  var network = bitcoin.networks[this.networkName];
  if ((index = this.addresses.indexOf(address)) > -1) {
    return new bitcoin.ECPair(BigInteger.fromBuffer(this.externalAccount.deriveChild(index).privateKey), null, {
      network: network
    });
  } else if ((index = this.changeAddresses.indexOf(address)) > -1) {
    return new bitcoin.ECPair(BigInteger.fromBuffer(this.internalAccount.deriveChild(index).privateKey), null, {
      network: network
    });
  } else {
    throw new Error('Unknown address. Make sure the address is from the keychain and has been generated.');
  }
};

Wallet.prototype.createTx = function(to, value, fee, minConf, unspents) {
  if (typeof value === 'string') value = parseInt(value);
  if (typeof fee === 'string') fee = parseInt(fee);

  var network = bitcoin.networks[this.networkName];
  validate.preCreateTx(to, value, network);

  if (minConf == null) {
    minConf = this.minConf;
  }

  var utxos = null;
  if (unspents != null) {
    validate.utxos(unspents);
    utxos = unspents.filter(function(unspent) {
      return unspent.confirmations >= minConf;
    });
  } else {
    utxos = getCandidateOutputs(this.unspents, minConf);
  }

  utxos = utxos.sort(function(o1, o2){
    return o2.value - o1.value;
  });

  var accum = 0;
  var estimatedFee = 0;
  var subTotal = value;
  unspents = [];

  var builder = new bitcoin.TransactionBuilder(network);
  builder.addOutput(to, value);

  var that = this;
  utxos.some(function(unspent) {
    builder.addInput(unspent.txId, unspent.vout);
    unspents.push(unspent);

    if (fee == undefined) {
      estimatedFee = estimateFeePadChangeOutput(builder.buildIncomplete(), network, network.feePerKb);
    } else {
      estimatedFee = fee;
    }

    accum += unspent.value;
    subTotal = value + estimatedFee;
    if (accum >= subTotal) {
      var change = accum - subTotal;
      if (change > network.dustThreshold) {
        builder.addOutput(that.getNextChangeAddress(), change);
      }
      return true;
    }
  });

  validate.postCreateTx(value, accum, this.getBalance(), estimatedFee);

  if (this.networkName === 'bitcoincash') {
    var hashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
    builder.enableBitcoinCash(true);
    unspents.forEach(function(unspent, i) {
      builder.sign(i, that.getPrivateKeyForAddress(unspent.address), null, hashType, unspent.value);
    });
  } else {
    unspents.forEach(function(unspent, i) {
      builder.sign(i, that.getPrivateKeyForAddress(unspent.address));
    });
  }

  return builder.build();
};

Wallet.prototype.estimateFees = function(to, value, feeRates, unspents) {
  if (typeof value !== 'number') value = parseInt(value);

  var network = bitcoin.networks[this.networkName];
  validate.preCreateTx(to, value, network);

  var minConf = this.minConf;
  var utxos = null;
  if (unspents != null) {
    validate.utxos(unspents);
    utxos = unspents.filter(function(unspent) {
      return unspent.confirmations >= minConf;
    });
  } else {
    utxos = getCandidateOutputs(this.unspents, minConf);
  }
  utxos = utxos.sort(function(o1, o2) {
    return o2.value - o1.value;
  });

  var subTotal = value;
  var fees = [];

  for (var i = 0; i < feeRates.length; i++) {
    var builder = new bitcoin.TransactionBuilder(network);
    builder.addOutput(to, value);

    var accum = 0;
    var estimatedFee = 0;
    utxos.some(function(unspent) {
      builder.addInput(unspent.txId, unspent.vout);

      estimatedFee = estimateFeePadChangeOutput(builder.buildIncomplete(), network, feeRates[i]);

      accum += unspent.value;
      subTotal = value + estimatedFee;

      if (accum >= subTotal) {
        return true;
      }
    });

    fees.push(estimatedFee);
  }
  return fees;
};

Wallet.prototype.sendTx = function(tx, done) {
  var that = this;
  this.api.transactions.propagate(tx.toHex()).then(function() {
    that.processTx(tx, done);
  }).catch(done);
};

Wallet.prototype.processTx = function(tx, done) {
  var that = this;
  var foundUsed = true;
  while (foundUsed) {
    foundUsed = addToAddresses.bind(this)(this.getNextAddress(), this.getNextChangeAddress());
  }

  var allAddresses = that.addresses.concat(that.changeAddresses);

  fetchTransactions(that.api, allAddresses, [tx.getId()]).then(function(historyTxs) {
    var historyTx = historyTxs[0];
    that.balance += (historyTx.amount - historyTx.fees);
    historyTx.vin.forEach(function(input) {
      that.unspents = that.unspents.filter(function(unspent) {
        return unspent.txId !== input.txid;
      });
    });
    that.historyTxs.unshift(historyTx);
    done(null, historyTx);
  }).catch(done);

  function addToAddresses(nextAddress, nextChangeAddress) {
    var found = tx.outs.some(function(out){
      var address = bitcoin.address.fromOutputScript(out.script, bitcoin.networks[this.networkName]).toString();
      if (nextChangeAddress === address) {
        this.changeAddresses.push(address);
        return true;
      } else if (nextAddress === address) {
        this.addresses.push(address);
        return true;
      }
    }, this);

    if (found) return true;
  }
};

Wallet.prototype.createPrivateKey = function(wif) {
  var network = bitcoin.networks[this.networkName];
  return bitcoin.ECPair.fromWIF(wif, network);
};

Wallet.prototype.createImportTx = function(options) {
  var network = bitcoin.networks[this.networkName];
  var builder = new bitcoin.TransactionBuilder(network);
  if (typeof options.fee === 'string') options.fee = parseInt(options.fee);
  var amount = options.amount - options.fee;
  if (amount < 0) {
    throw new Error('Insufficient funds');
  }
  options.unspents.forEach(function(unspent) {
    builder.addInput(unspent.txId, unspent.vout);
  });
  builder.addOutput(options.to, amount);

  if (this.networkName === 'bitcoincash') {
    var hashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
    builder.enableBitcoinCash(true);
    builder.inputs.forEach(function(input, i) {
      builder.sign(i, options.privateKey, null, hashType, options.unspents[i].value);
    });
  } else {
    builder.inputs.forEach(function(input, i) {
      builder.sign(i, options.privateKey);
    });
  }
  return builder.build();
};

Wallet.prototype.getImportTxOptions = function(privateKey) {
  var that = this;
  var address = privateKey.getAddress();
  return that.api.addresses.unspents([address]).then(function(unspents) {
    unspents = unspents.filter(function(unspent) {
      return unspent.confirmations >= that.minConf;
    });
    var amount = unspents.reduce(function(total, unspent) {
      return total += unspent.value;
    }, 0);
    return {
      privateKey: privateKey,
      unspents: unspents,
      amount: amount
    };
  });
};

function getCandidateOutputs(unspents, minConf) {
  return unspents.filter(function(unspent) {
    return unspent.confirmations >= minConf;
  });
}

function estimateFeePadChangeOutput(tx, network, feePerKb) {
  var tmpTx = tx.clone();
  tmpTx.addOutput(tx.outs[0].script, network.dustSoftThreshold || 0);

  var baseFee = feePerKb / 1000;
  var byteSize = tmpTx.ins.length * 148 + tmpTx.outs.length * 34 + 10;

  var fee = baseFee * byteSize;
  if (network.dustSoftThreshold === undefined) return fee;

  tmpTx.outs.forEach(function (e) {
    if (e.value < network.dustSoftThreshold) {
      fee += feePerKb;
    }
  });
  return fee;
}

Wallet.prototype.getTransactionHistory = function() {
  return this.historyTxs.sort(function(a, b) {
    return a.confirmations - b.confirmations;
  });
};

Wallet.prototype.serialize = function() {

  return JSON.stringify({
    externalAccount: this.externalAccount.privateExtendedKey,
    internalAccount: this.internalAccount.privateExtendedKey,
    addressIndex: this.addresses.length,
    changeAddressIndex: this.changeAddresses.length,
    networkName: this.networkName,
    balance: this.getBalance(),
    unspents: this.unspents,
    historyTxs: this.historyTxs,
    minConf: this.minConf
  });
};

Wallet.deserialize = function(json) {
  var wallet = new Wallet();
  var deserialized = JSON.parse(json);
  var network = bitcoin.networks[deserialized.networkName];
  wallet.externalAccount = HDKey.fromExtendedKey(deserialized.externalAccount, network.bip32);
  wallet.internalAccount = HDKey.fromExtendedKey(deserialized.internalAccount, network.bip32);
  wallet.addresses = deriveAddresses(wallet.externalAccount, network, deserialized.addressIndex);
  wallet.changeAddresses = deriveAddresses(wallet.internalAccount, network, deserialized.changeAddressIndex);
  wallet.networkName = deserialized.networkName;
  wallet.api = getAPI(deserialized.networkName);
  wallet.balance = deserialized.balance;
  wallet.unspents = deserialized.unspents;
  wallet.historyTxs = deserialized.historyTxs;
  wallet.minConf = deserialized.minConf;

  return wallet;
};

function getAddress(node, networkName) {
  var hash = bitcoin.crypto.hash160(node.publicKey);
  var pubKeyHash = bitcoin.networks[networkName].pubKeyHash;
  return bitcoin.address.toBase58Check(hash, pubKeyHash);
}

function deriveAddresses(account, network, untilId) {
  var addresses = [];
  for (var i = 0; i < untilId; i++) {
    var hash = bitcoin.crypto.hash160(account.deriveChild(i).publicKey);
    var pubKeyHash = network.pubKeyHash;
    addresses.push(bitcoin.address.toBase58Check(hash, pubKeyHash));
  }
  return addresses;
}

module.exports = Wallet;

