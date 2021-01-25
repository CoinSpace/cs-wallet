'use strict';

const bitcoin = require('./bitcoin');
const { discoverAddresses } = require('./api/functions');
const { fetchTransactions } = require('./api/functions');
const { fetchUnspents } = require('./api/functions');
const API = require('./api');
const HDKey = require('hdkey');
const BigInteger = require('bigi');
const fee = require('./fee');
const transaction = require('./transaction');
const bchaddr = require('bchaddrjs');

function getAPI(networkName) {
  let baseURL = null;
  const network = bitcoin.networks[networkName];
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

  const { seed } = options;
  let { publicKey } = options;

  const { networkName } = options;
  const network = bitcoin.networks[networkName];

  this.networkName = networkName;
  this.network = network;
  this.api = getAPI(networkName);
  this.balance = 0;
  this.historyTxIdsSorted = undefined;
  this.txsPerPage = options.txsPerPage || 5;
  this.txsCursor = undefined;
  this.unspents = [];
  this.isLocked = !seed;

  this.denomination = network.denomination;
  this.name = network.name;

  let hdkey;
  if (seed) {
    hdkey = HDKey.fromMasterSeed(Buffer.from(options.seed, 'hex'), network.bip32);
  } else if (publicKey) {
    publicKey = JSON.parse(publicKey);
  } else {
    throw new Error('seed or publicKey should be passed');
  }
  this.accounts = network.addressTypes.reduce((result, type) => {
    let base;
    if (hdkey) {
      if (type === 'p2pkh') {
        base = hdkey.derive("m/0'");
      } else if (type === 'p2sh') {
        base = hdkey.derive(network.bip49);
      } else if (type === 'p2wpkh') {
        base = hdkey.derive(network.bip84);
      }
    } else if (publicKey) {
      const extendedKey = publicKey[type] || publicKey.p2pkh;
      base = HDKey.fromExtendedKey(extendedKey, network.bip32);
    }
    result[type] = {
      external: base.deriveChild(0),
      internal: base.deriveChild(1),
      base,
      addresses: [],
      changeAddresses: [],
    };
    return result;
  }, {});

  let defaultAddressType = 'p2pkh';
  if (networkName === 'bitcoin' || networkName === 'litecoin') {
    defaultAddressType = 'p2wpkh';
  }
  this.addressType = options.addressType || defaultAddressType;
  this.minConf = options.minConf || 0;
  this.maxTxInputs = options.maxTxInputs || 650; // ~100kb
  this.feeRates = [{
    name: 'minimum',
    value: this.network.feePerByte,
    default: true,
  }];
  this.replaceByFeeFactor = options.replaceByFeeFactor || 1.5;
  this.replaceByFeeEnabled = networkName === 'bitcoin';
  this.maxAmounts = [];
  this.csFee = 0;
  this.csMinFee = 0;
  this.csMaxFee = 0;
  this.csRbfFee = 0;
  this.csFeeAddresses = [];
  this.csFeeOff = false;
  this._txIds = [];
}

Wallet.bitcoin = bitcoin;

Wallet.prototype.load = function(options) {
  const that = this;

  const { done } = options;

  Promise.all([
    options.getDynamicFees(),
    options.getCsFee(),
    that.network.addressTypes.reduce((promise, type) => {
      return promise.then((unspentAddresses) => {
        return discoverAddresses(
          that,
          that.accounts[type].external, that.accounts[type].internal,
          (node) => {
            return that.getAddress(node.publicKey, type);
          }
        ).then((data) => {
          that.accounts[type].addresses = data.addresses;
          that.accounts[type].changeAddresses = data.changeAddresses;
          that.balance += data.balance;
          that._txIds = that._txIds.concat(data.txIds);
          return unspentAddresses.concat(data.unspentAddresses);
        });
      });
    }, Promise.resolve([])),
  ]).then((results) => {
    if (results[0]) {
      that.feeRates = results[0].items;
    }
    if (results[1]) {
      that.csFee = results[1].fee;
      that.csMinFee = results[1].minFee;
      that.csMaxFee = results[1].maxFee;
      that.csRbfFee = results[1].rbfFee;
      that.csFeeAddresses = results[1].addresses;
      const whitelist = results[1].whitelist || [];
      const firstAddress = that.getAddress(that.accounts.p2pkh.external.deriveChild(0).publicKey, 'p2pkh');
      that.csFeeOff = whitelist.indexOf(firstAddress) !== -1;
    }
    that._txIds = that._txIds.filter((item, i) => {
      return that._txIds.indexOf(item) === i;
    });
    const unspentAddresses = results[2];
    return fetchUnspents(that, unspentAddresses).then((utxos) => {
      that.unspents = utxos;
      that.maxAmounts = fee.getMaxAmounts(that);
      done(null, that);
    });
  }).catch(done);
};

Wallet.prototype.loadTxs = function() {
  const that = this;
  let promise = Promise.resolve();
  if (!that.historyTxIdsSorted) {
    promise = that.api.transactions.getSortedTxIds(that._txIds).then((txIds) => {
      that.historyTxIdsSorted = txIds;
    });
  }
  return promise.then(() => {
    const allAddresses = that.getAllAddresses();
    const start = that.txsCursor ? that.historyTxIdsSorted.indexOf(that.txsCursor) + 1 : 0;
    const txIds = that.historyTxIdsSorted.slice(start, start + that.txsPerPage);
    return fetchTransactions(that, allAddresses, txIds).then((txs) => {
      const hasMoreTxs = txs.length === that.txsPerPage;
      that.txsCursor = hasMoreTxs ? txs[txs.length - 1].id : undefined;
      return {
        txs,
        hasMoreTxs,
      };
    });
  });
};

Wallet.prototype.lock = function() {
  const that = this;
  Object.keys(that.accounts).forEach((type) => {
    const account = that.accounts[type];
    account.external.wipePrivateData();
    account.internal.wipePrivateData();
    account.base.wipePrivateData();
  });
  this.isLocked = true;
};

Wallet.prototype.unlock = function(seed) {
  const that = this;
  const hdkey = HDKey.fromMasterSeed(Buffer.from(seed, 'hex'), that.network.bip32);
  Object.keys(that.accounts).forEach((type) => {
    let base;
    if (type === 'p2pkh') {
      base = hdkey.derive("m/0'");
    } else if (type === 'p2sh') {
      base = hdkey.derive(that.network.bip49);
    } else if (type === 'p2wpkh') {
      base = hdkey.derive(that.network.bip84);
    }
    const account = that.accounts[type];
    account.base = base;
    account.external = base.deriveChild(0);
    account.internal = base.deriveChild(1);
  });
  this.isLocked = false;
};

Wallet.prototype.publicKey = function() {
  const that = this;
  const publicKey = {};
  Object.keys(that.accounts).forEach((type) => {
    const account = that.accounts[type];
    publicKey[type] = account.base.publicExtendedKey;
  });
  return JSON.stringify(publicKey);
};

Wallet.prototype.getBalance = function() {
  return this.balance;
};

Wallet.prototype.getUnspentsForTx = function(options) {
  options = options || {};
  const { minConf } = this;
  const utxos = options.unspents || this.unspents;
  const gap = options.gap || 0;
  return utxos.filter((unspent) => {
    return unspent.confirmations >= minConf;
  }).sort((o1, o2) => {
    return o2.value - o1.value;
  }).slice(0, this.maxTxInputs + gap);
};

Wallet.prototype.getNextChangeAddress = function() {
  const account = this.accounts[this.addressType];
  const node = account.internal.deriveChild(account.changeAddresses.length);
  return this.getAddress(node.publicKey, this.addressType);
};

Wallet.prototype.getNextAddress = function(oldFormat) {
  const account = this.accounts[this.addressType];
  const node = account.external.deriveChild(account.addresses.length);
  const address = this.getAddress(node.publicKey, this.addressType);
  if (this.networkName === 'bitcoincash' && !oldFormat) {
    return bchaddr.toCashAddress(address).split(':')[1];
  }
  return address;
};

Wallet.prototype.getAddress = function(publicKeyBuffer, type) {
  const hash = bitcoin.crypto.hash160(publicKeyBuffer);
  type = type || 'p2pkh';
  if (type === 'p2pkh') {
    const { pubKeyHash } = this.network;
    return bitcoin.address.toBase58Check(hash, pubKeyHash);
  }
  if (type === 'p2sh') {
    const witnessScript = bitcoin.script.witnessPubKeyHash.output.encode(hash);
    const scriptPubKey = bitcoin.script.scriptHash.output.encode(bitcoin.crypto.hash160(witnessScript));
    return bitcoin.address.fromOutputScript(scriptPubKey, this.network);
  }
  if (type === 'p2wpkh') {
    const { bech32 } = this.network;
    return bitcoin.address.toBech32(hash, 0, bech32);
  }
};

Wallet.prototype.getAllAddresses = function() {
  const that = this;
  const addresses = Object.keys(that.accounts).reduce((result, key) => {
    return result.concat(that.accounts[key].addresses);
  }, []);
  const changeAddresses = Object.keys(that.accounts).reduce((result, key) => {
    return result.concat(that.accounts[key].changeAddresses);
  }, []);
  return addresses.concat(changeAddresses);
};

Wallet.prototype.exportPrivateKeys = function() {
  if (this.unspents.length === 0) return '';
  const that = this;
  const lines = ['address,privatekey'];
  const exported = {};
  that.unspents.forEach((unspent) => {
    if (exported[unspent.address]) return false;
    exported[unspent.address] = true;
    let { address } = unspent;
    if (that.networkName === 'bitcoincash') {
      address = bchaddr.toCashAddress(address).split(':')[1];
    }
    lines.push(address + ',' + that.getPrivateKeyForAddress(unspent.address).toWIF(that.network));
  });
  return lines.join('\n');
};

Wallet.prototype.getPrivateKeyForAddress = function(address) {
  const that = this;
  let index;
  const types = Object.keys(that.accounts);
  for (let i = 0; i < types.length; i++) {
    const type = that.network.addressTypes[i];
    const account = that.accounts[type];
    if ((index = account.addresses.indexOf(address)) > -1) {
      return new bitcoin.ECPair(BigInteger.fromBuffer(account.external.deriveChild(index).privateKey), null, {
        network: that.network,
      });
    } else if ((index = account.changeAddresses.indexOf(address)) > -1) {
      return new bitcoin.ECPair(BigInteger.fromBuffer(account.internal.deriveChild(index).privateKey), null, {
        network: that.network,
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

Wallet.prototype.createReplacement = function(tx) {
  return transaction.createReplacement(this, tx);
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
    maxTxInputs: this.maxTxInputs,
    replaceByFeeFactor: this.replaceByFeeFactor,
  });
};

Wallet.deserialize = function(json) {
  const wallet = new Wallet();
  const deserialized = JSON.parse(json);
  const network = bitcoin.networks[deserialized.networkName];
  const base = HDKey.fromExtendedKey(deserialized.baseAccount, network.bip32);
  wallet.accounts = {
    p2pkh: {
      base,
      external: base.deriveChild(0),
      internal: base.deriveChild(1),
      addresses: deriveAddresses(base.deriveChild(0), network, deserialized.addressIndex),
      changeAddresses: deriveAddresses(base.deriveChild(1), network, deserialized.changeAddressIndex),
    },
  };
  wallet.addressType = deserialized.addressType;
  wallet.networkName = deserialized.networkName;
  wallet.network = network;
  wallet.api = getAPI(deserialized.networkName);
  wallet.balance = deserialized.balance;
  wallet.unspents = deserialized.unspents;
  wallet.minConf = deserialized.minConf;
  wallet.maxTxInputs = deserialized.maxTxInputs;
  wallet.replaceByFeeFactor = deserialized.replaceByFeeFactor;
  wallet.replaceByFeeEnabled = deserialized.networkName === 'bitcoin';
  wallet.csRbfFee = deserialized.csRbfFee;
  wallet.feeRates = [{
    name: 'minimum',
    value: network.feePerByte,
    default: true,
  }];
  wallet.maxAmounts = [];
  wallet._txIds = [];

  return wallet;
};

function deriveAddresses(account, network, untilId) {
  const addresses = [];
  for (let i = 0; i < untilId; i++) {
    const hash = bitcoin.crypto.hash160(account.deriveChild(i).publicKey);
    const { pubKeyHash } = network;
    addresses.push(bitcoin.address.toBase58Check(hash, pubKeyHash));
  }
  return addresses;
}

module.exports = Wallet;
