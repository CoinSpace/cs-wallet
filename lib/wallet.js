'use strict';

var assert = require('assert');
var bitcoin = require('./bitcoin');
var discoverAddresses = require('./api/functions').discoverAddresses;
var fetchTransactions = require('./api/functions').fetchTransactions;
var fetchUnspents = require('./api/functions').fetchUnspents;
var API = require('./api');
var HDKey = require('hdkey');
var BigInteger = require('bigi');
var fee = require('./fee');
var transaction = require('./transaction');
var bchaddr = require('bchaddrjs');

function getAPI(network) {
  var baseURL = null;
  if ((network === 'bitcoin')) {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_BTC_URL;
  } else if (network === 'bitcoincash') {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_BCH_URL;
  } else if (network === 'litecoin') {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_LTC_URL;
  } else if (network === 'dogecoin') {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_DOGE_URL;
  } else if (network === 'dash') {
    // eslint-disable-next-line no-undef
    baseURL = process.env.API_DASH_URL;
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
  this.addresses = [];
  this.changeAddresses = [];
  this.minConf = options.minConf || 4;
  this.feeRates = [{
    name: 'minimum',
    value: bitcoin.networks[this.networkName].feePerKb / 1000, // per byte
    default: true
  }];
  this.maxAmounts = [];
  this.csFee = 0;
  this.csMinFee = 0;
  this.csMaxFee = 0;
  this.csFeeAddresses = [];
  this.csFeeOff = false;

  var that = this;
  var addressFunction = function(node) {
    return getAddress(node, networkName);
  };

  var txIds = [];
  var allAddresses = [];

  Promise.all([
    options.getDynamicFees(),
    options.getCsFee(),
    discoverAddresses(
      this.api,
      this.externalAccount, this.internalAccount,
      addressFunction
    )
  ]).then(function(results) {
    if (results[0]) {
      that.feeRates = results[0].items;
    }
    if (results[1]) {
      that.csFee = results[1].fee;
      that.csMinFee = results[1].minFee;
      that.csMaxFee = results[1].maxFee;
      that.csFeeAddresses = results[1].addresses;
    }
    var data = results[2];
    that.addresses = data.addresses;
    that.changeAddresses = data.changeAddresses;
    that.balance = data.balance;
    txIds = data.txIds;
    allAddresses = that.addresses.concat(that.changeAddresses);
    return fetchUnspents(that.api, data.unspentAddresses).then(function(utxos) {
      that.unspents = utxos;
      that.maxAmounts = fee.getMaxAmounts(that);
      that.csFeeOff = utxos.some(function(unspent) {
        return that.csFeeAddresses.indexOf(unspent.address) !== -1;
      });
      done(null, that);
    });
  }).catch(done).then(function() {
    return fetchTransactions(that.api, allAddresses, txIds, that.csFeeAddresses).then(function(historyTxs) {
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

Wallet.prototype.getNextAddress = function(oldFormat) {
  var address = getAddress(this.externalAccount.deriveChild(this.addresses.length), this.networkName);
  if (this.networkName === 'bitcoincash' && !oldFormat) {
    return bchaddr.toCashAddress(address).split(':')[1];
  }
  return address;
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
    var address = unspent.address;
    if (that.networkName === 'bitcoincash') {
      address = bchaddr.toCashAddress(address).split(':')[1];
    }
    lines.push(address + ',' + that.getPrivateKeyForAddress(unspent.address).toWIF(network));
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

Wallet.prototype.createTx = function(to, value, fee) {
  return transaction.createTx(this, to, value, fee);
};

Wallet.prototype.sendTx = function(tx, done) {
  return transaction.sendTx(this, tx, done);
};

Wallet.prototype.createPrivateKey = function(wif) {
  var network = bitcoin.networks[this.networkName];
  return bitcoin.ECPair.fromWIF(wif, network);
};

Wallet.prototype.createImportTx = function(options) {
  return transaction.createImportTx(this, options);
};

Wallet.prototype.getImportTxOptions = function(privateKey) {
  return transaction.getImportTxOptions(this, privateKey);
};

Wallet.prototype.minimumFees = function(value) {
  return fee.minimumFees(this, value);
};

Wallet.prototype.estimateFees = function(value, unspents) {
  return fee.estimateFees(this, value, unspents);
};

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
  wallet.feeRates = [{
    name: 'minimum',
    value: bitcoin.networks[deserialized.networkName].feePerKb / 1000, // per byte
    default: true
  }];
  wallet.maxAmounts = [];

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
