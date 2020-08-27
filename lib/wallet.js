'use strict';

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

  var seed = options.seed;
  var publicKey = options.publicKey;

  var networkName = options.networkName;
  var network = bitcoin.networks[networkName];

  this.networkName = networkName;
  this.network = network;
  this.api = getAPI(networkName);
  this.balance = 0;
  this.historyTxIdsSorted = undefined;
  this.txsPerPage = options.txsPerPage || 5;
  this.txsCursor = undefined;
  this.unspents = [];
  this.isLocked = !seed;

  var hdkey;
  if (seed) {
    hdkey = HDKey.fromMasterSeed(Buffer.from(options.seed, 'hex'), network.bip32);
  } else if (publicKey) {
    publicKey = JSON.parse(publicKey);
  } else {
    throw new Error('seed or publicKey should be passed');
  }
  this.accounts = network.addressTypes.reduce(function(result, type) {
    var base;
    if (hdkey) {
      if (type === 'p2pkh') {
        base = hdkey.derive("m/0'");
      } else if (type === 'p2sh') {
        base = hdkey.derive(network.bip49);
      } else if (type === 'p2wpkh') {
        base = hdkey.derive(network.bip84);
      }
    } else if (publicKey) {
      var extendedKey = publicKey[type] || publicKey.p2pkh;
      base = HDKey.fromExtendedKey(extendedKey, network.bip32);
    }
    result[type] = {
      external: base.deriveChild(0),
      internal: base.deriveChild(1),
      base: base,
      addresses: [],
      changeAddresses: []
    };
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
}

Wallet.bitcoin = bitcoin;

Wallet.prototype.load = function(options) {
  var that = this;

  var done = options.done;

  Promise.all([
    options.getDynamicFees(),
    options.getCsFee(),
    that.network.addressTypes.reduce(function(promise, type) {
      return promise.then(function(unspentAddresses) {
        return discoverAddresses(
          that.api,
          that.accounts[type].external, that.accounts[type].internal,
          function(node) {
            return that.getAddress(node.publicKey, type);
          }
        ).then(function(data) {
          that.accounts[type].addresses = data.addresses;
          that.accounts[type].changeAddresses = data.changeAddresses;
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
      var firstAddress = that.getAddress(that.accounts.p2pkh.external.deriveChild(0).publicKey, 'p2pkh');
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
};

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

Wallet.prototype.lock = function() {
  var that = this;
  Object.keys(that.accounts).forEach(function(type) {
    var account = that.accounts[type];
    account.external.wipePrivateData();
    account.internal.wipePrivateData();
    account.base.wipePrivateData();
  });
  this.isLocked = true;
};

Wallet.prototype.unlock = function(privateKey) {
  var that = this;
  privateKey = JSON.parse(privateKey);
  Object.keys(that.accounts).forEach(function(type) {
    var account = that.accounts[type];
    var extendedKey = privateKey[type] || privateKey.p2pkh;
    var base = HDKey.fromExtendedKey(extendedKey, that.network.bip32);
    account.base = base;
    account.external = base.deriveChild(0);
    account.internal = base.deriveChild(1);
  });
  this.isLocked = false;
};

Wallet.prototype.dumpKeys = function() {
  if (this.isLocked) throw new Error('wallet is locked');
  var that = this;
  var dump = {
    public: {},
    private: {}
  };
  Object.keys(that.accounts).forEach(function(type) {
    var account = that.accounts[type];
    dump.public[type] = account.base.publicExtendedKey;
    dump.private[type] = account.base.privateExtendedKey;
  });
  return {
    public: JSON.stringify(dump.public),
    private: JSON.stringify(dump.private)
  };
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
  var account = this.accounts[this.addressType];
  var node = account.internal.deriveChild(account.changeAddresses.length);
  return this.getAddress(node.publicKey, this.addressType);
};

Wallet.prototype.getNextAddress = function(oldFormat) {
  var account = this.accounts[this.addressType];
  var node = account.external.deriveChild(account.addresses.length);
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
  var addresses = Object.keys(that.accounts).reduce(function(result, key) {
    return result.concat(that.accounts[key].addresses);
  }, []);
  var changeAddresses = Object.keys(that.accounts).reduce(function(result, key) {
    return result.concat(that.accounts[key].changeAddresses);
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
  var types = Object.keys(that.accounts);
  for (var i = 0; i < types.length; i++) {
    var type = that.network.addressTypes[i];
    var account = that.accounts[type];
    if ((index = account.addresses.indexOf(address)) > -1) {
      return new bitcoin.ECPair(BigInteger.fromBuffer(account.external.deriveChild(index).privateKey), null, {
        network: that.network
      });
    } else if ((index = account.changeAddresses.indexOf(address)) > -1) {
      return new bitcoin.ECPair(BigInteger.fromBuffer(account.internal.deriveChild(index).privateKey), null, {
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
    baseAccount: this.accounts.p2pkh.base.privateExtendedKey,
    addressIndex: this.accounts.p2pkh.addresses.length,
    changeAddressIndex: this.accounts.p2pkh.changeAddresses.length,
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
  var base = HDKey.fromExtendedKey(deserialized.baseAccount, network.bip32);
  wallet.accounts = {
    p2pkh: {
      base: base,
      external: base.deriveChild(0),
      internal: base.deriveChild(1),
      addresses: deriveAddresses(base.deriveChild(0), network, deserialized.addressIndex),
      changeAddresses: deriveAddresses(base.deriveChild(1), network, deserialized.changeAddressIndex)
    }
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
