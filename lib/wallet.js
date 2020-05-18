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

function getAPI(networkName) {
  var baseURL = null;
  var network = bitcoin.networks[networkName];
  if ((networkName === 'bitcoin')) {
    baseURL = process.env.API_BTC_URL; // eslint-disable-line no-undef
  } else if (networkName === 'bitcoincash') {
    baseURL = process.env.API_BCH_URL; // eslint-disable-line no-undef
  } else if (networkName === 'bitcoinsv') {
    baseURL = process.env.API_BSV_URL; // eslint-disable-line no-undef
  } else if (networkName === 'litecoin') {
    baseURL = process.env.API_LTC_URL; // eslint-disable-line no-undef
  } else if (networkName === 'dogecoin') {
    baseURL = process.env.API_DOGE_URL; // eslint-disable-line no-undef
  } else if (networkName === 'dash') {
    baseURL = process.env.API_DASH_URL; // eslint-disable-line no-undef
  }
  return new API(baseURL, network);
}

function Wallet(options) {
  if (arguments.length === 0) return this;

  var externalAccount = options.externalAccount;
  var internalAccount = options.internalAccount;
  var networkName = options.networkName;
  var network = bitcoin.networks[networkName];
  var done = options.done;

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
    return done(err);
  }

  this.networkName = networkName;
  this.network = network;
  this.api = getAPI(networkName);
  this.balance = 0;
  this.historyTxIdsSorted = undefined;
  this.txsPerPage = options.txsPerPage || 5;
  this.txsCursor = undefined;
  this.unspents = [];
  this.addresses = network.addressTypes.reduce(function(result, type) {
    result[type] = [];
    return result;
  }, {});
  this.changeAddresses = network.addressTypes.reduce(function(result, type) {
    result[type] = [];
    return result;
  }, {});
  this.addressType = options.addressType || 'p2pkh';
  this.minConf = options.minConf || 0;
  this.maxTxInputs = options.maxTxInputs || 650; // ~100kb
  this.feeRates = [{
    name: 'minimum',
    value: this.network.feePerKb / 1000, // per byte
    default: true
  }];
  this.maxAmounts = [];
  this.csFee = 0;
  this.csMinFee = 0;
  this.csMaxFee = 0;
  this.csFeeAddresses = [];
  this.csFeeOff = false;
  this._txIds = [];

  var that = this;

  Promise.all([
    options.getDynamicFees(),
    options.getCsFee(),
    network.addressTypes.reduce(function(promise, type) {
      return promise.then(function(unspentAddresses) {
        return discoverAddresses(
          that.api,
          that.externalAccount, that.internalAccount,
          function(node) {
            return that.getAddress(node.publicKey, type);
          }
        ).then(function(data) {
          that.addresses[type] = data.addresses;
          that.changeAddresses[type] = data.changeAddresses;
          that.balance += data.balance;
          that._txIds = that._txIds.concat(data.txIds);
          return unspentAddresses.concat(data.unspentAddresses);
        });
      });
    }, Promise.resolve([]))
  ]).then(function(results) {
    if (results[0]) {
      that.feeRates = results[0].items;
    }
    if (results[1]) {
      that.csFee = results[1].fee;
      that.csMinFee = results[1].minFee;
      that.csMaxFee = results[1].maxFee;
      that.csFeeAddresses = results[1].addresses;
      var whitelist = results[1].whitelist || [];
      var firstAddress = that.getAddress(that.externalAccount.deriveChild(0).publicKey, 'p2pkh');
      that.csFeeOff = whitelist.indexOf(firstAddress) !== -1;
    }
    that._txIds = that._txIds.filter(function(item, i) {
      return that._txIds.indexOf(item) === i;
    });
    var unspentAddresses = results[2];
    return fetchUnspents(that.api, unspentAddresses).then(function(utxos) {
      that.unspents = utxos;
      that.maxAmounts = fee.getMaxAmounts(that);
      done(null, that);
    });
  }).catch(done);
}

Wallet.bitcoin = bitcoin;

Wallet.prototype.loadTxs = function() {
  var that = this;
  var promise = Promise.resolve();
  if (!that.historyTxIdsSorted) {
    promise = that.api.transactions.getSortedTxIds(that._txIds).then(function(txIds) {
      that.historyTxIdsSorted = txIds;
    });
  }
  return promise.then(function() {
    var allAddresses = that.getAllAddresses();
    var start = that.txsCursor ? that.historyTxIdsSorted.indexOf(that.txsCursor) + 1 : 0;
    var txIds = that.historyTxIdsSorted.slice(start, start + that.txsPerPage);
    return fetchTransactions(that.api, allAddresses, txIds, that.csFeeAddresses).then(function(txs) {
      var hasMoreTxs = txs.length === that.txsPerPage;
      that.txsCursor = hasMoreTxs ? txs[txs.length - 1].txId : undefined;
      return {
        txs: txs,
        hasMoreTxs: hasMoreTxs
      };
    });
  });
};

Wallet.prototype.getBalance = function() {
  return this.balance;
};

Wallet.prototype.getUnspentsForTx = function(options) {
  options = options || {};
  var minConf = this.minConf;
  var utxos = options.unspents || this.unspents;
  var gap = options.gap || 0;
  return utxos.filter(function(unspent) {
    return unspent.confirmations >= minConf;
  }).sort(function(o1, o2) {
    return o2.value - o1.value;
  }).slice(0, this.maxTxInputs + gap);
};

Wallet.prototype.getNextChangeAddress = function() {
  var node = this.internalAccount.deriveChild(this.changeAddresses[this.addressType].length);
  return this.getAddress(node.publicKey, this.addressType);
};

Wallet.prototype.getNextAddress = function(oldFormat) {
  var node = this.externalAccount.deriveChild(this.addresses[this.addressType].length);
  var address = this.getAddress(node.publicKey, this.addressType);
  if (this.networkName === 'bitcoincash' && !oldFormat) {
    return bchaddr.toCashAddress(address).split(':')[1];
  }
  return address;
};

Wallet.prototype.getAddress = function(publicKeyBuffer, type) {
  var hash = bitcoin.crypto.hash160(publicKeyBuffer);
  type = type || 'p2pkh';
  if (type === 'p2pkh') {
    var pubKeyHash = this.network.pubKeyHash;
    return bitcoin.address.toBase58Check(hash, pubKeyHash);
  }
  if (type === 'p2sh') {
    var witnessScript = bitcoin.script.witnessPubKeyHash.output.encode(hash);
    var scriptPubKey = bitcoin.script.scriptHash.output.encode(bitcoin.crypto.hash160(witnessScript));
    return bitcoin.address.fromOutputScript(scriptPubKey, this.network);
  }
  if (type === 'p2wpkh') {
    var bech32 = this.network.bech32;
    return bitcoin.address.toBech32(hash, 0, bech32);
  }
};

Wallet.prototype.getAllAddresses = function() {
  var that = this;
  var addresses = Object.keys(that.addresses).reduce(function(result, key) {
    return result.concat(that.addresses[key]);
  }, []);
  var changeAddresses = Object.keys(that.changeAddresses).reduce(function(result, key) {
    return result.concat(that.changeAddresses[key]);
  }, []);
  return addresses.concat(changeAddresses);
};

Wallet.prototype.exportPrivateKeys = function() {
  if (this.unspents.length === 0) return '';
  var that = this;
  var lines = ['address,privatekey'];
  var exported = {};
  that.unspents.forEach(function(unspent) {
    if (exported[unspent.address]) return false;
    exported[unspent.address] = true;
    var address = unspent.address;
    if (that.networkName === 'bitcoincash') {
      address = bchaddr.toCashAddress(address).split(':')[1];
    }
    lines.push(address + ',' + that.getPrivateKeyForAddress(unspent.address).toWIF(that.network));
  });
  return lines.join('\n');
};

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  var that = this;
  var index;
  for (var i = 0; i < that.network.addressTypes.length; i++) {
    var type = that.network.addressTypes[i];
    if ((index = that.addresses[type].indexOf(address)) > -1) {
      return new bitcoin.ECPair(BigInteger.fromBuffer(that.externalAccount.deriveChild(index).privateKey), null, {
        network: that.network
      });
    } else if ((index = that.changeAddresses[type].indexOf(address)) > -1) {
      return new bitcoin.ECPair(BigInteger.fromBuffer(that.internalAccount.deriveChild(index).privateKey), null, {
        network: that.network
      });
    }
  }
  throw new Error('Unknown address. Make sure the address is from the keychain and has been generated.');
};

Wallet.prototype.createTx = function(to, value, fee) {
  return transaction.createTx(this, to, value, fee);
};

Wallet.prototype.sendTx = function(tx, done) {
  return transaction.sendTx(this, tx, done);
};

Wallet.prototype.createPrivateKey = function(wif) {
  return bitcoin.ECPair.fromWIF(wif, this.network);
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

Wallet.prototype.serialize = function() {
  return JSON.stringify({
    externalAccount: this.externalAccount.privateExtendedKey,
    internalAccount: this.internalAccount.privateExtendedKey,
    addressIndex: this.addresses.p2pkh.length,
    changeAddressIndex: this.changeAddresses.p2pkh.length,
    networkName: this.networkName,
    balance: this.getBalance(),
    unspents: this.unspents,
    minConf: this.minConf,
    maxTxInputs: this.maxTxInputs
  });
};

Wallet.deserialize = function(json) {
  var wallet = new Wallet();
  var deserialized = JSON.parse(json);
  var network = bitcoin.networks[deserialized.networkName];
  wallet.externalAccount = HDKey.fromExtendedKey(deserialized.externalAccount, network.bip32);
  wallet.internalAccount = HDKey.fromExtendedKey(deserialized.internalAccount, network.bip32);
  wallet.addresses = {
    p2pkh: deriveAddresses(wallet.externalAccount, network, deserialized.addressIndex),
    p2sh: [],
    p2wpkh: []
  };
  wallet.changeAddresses = {
    p2pkh: deriveAddresses(wallet.internalAccount, network, deserialized.changeAddressIndex),
    p2sh: [],
    p2wpkh: []
  };
  wallet.addressType = deserialized.addressType;
  wallet.networkName = deserialized.networkName;
  wallet.network = network;
  wallet.api = getAPI(deserialized.networkName);
  wallet.balance = deserialized.balance;
  wallet.unspents = deserialized.unspents;
  wallet.minConf = deserialized.minConf;
  wallet.maxTxInputs = deserialized.maxTxInputs;
  wallet.feeRates = [{
    name: 'minimum',
    value: network.feePerKb / 1000, // per byte
    default: true
  }];
  wallet.maxAmounts = [];

  return wallet;
};

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
