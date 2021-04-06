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

class Wallet {
  constructor(options) {
    this.decimals = 8;
    this.balance = 0;

    if (!options) {
      return this;
    }

    const { seed } = options;
    let { publicKey } = options;

    const { networkName } = options;
    const network = bitcoin.networks[networkName];

    this.networkName = networkName;
    this.network = network;

    this.api = getAPI(networkName);
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
  load(options) {
    const { done } = options;
    this.getDynamicFees = options.getDynamicFees;
    this.getCsFee = options.getCsFee;

    Promise.all([
      this.getDynamicFees(),
      this.getCsFee(),
      this.network.addressTypes.reduce((promise, type) => {
        return promise.then((unspentAddresses) => {
          return discoverAddresses(
            this,
            this.accounts[type].external, this.accounts[type].internal,
            (node) => {
              return this.getAddress(node.publicKey, type);
            }
          ).then((data) => {
            this.accounts[type].addresses = data.addresses;
            this.accounts[type].changeAddresses = data.changeAddresses;
            this.balance += data.balance;
            this._txIds = this._txIds.concat(data.txIds);
            return unspentAddresses.concat(data.unspentAddresses);
          });
        });
      }, Promise.resolve([])),
    ]).then((results) => {
      if (results[0]) {
        this.feeRates = results[0].items;
      }
      if (results[1]) {
        this.csFee = results[1].fee;
        this.csMinFee = results[1].minFee;
        this.csMaxFee = results[1].maxFee;
        this.csRbfFee = results[1].rbfFee;
        this.csFeeAddresses = results[1].addresses;
        const whitelist = results[1].whitelist || [];
        const firstAddress = this.getAddress(this.accounts.p2pkh.external.deriveChild(0).publicKey, 'p2pkh');
        this.csFeeOff = whitelist.indexOf(firstAddress) !== -1;
      }
      this._txIds = this._txIds.filter((item, i) => {
        return this._txIds.indexOf(item) === i;
      });
      const unspentAddresses = results[2];
      return fetchUnspents(this, unspentAddresses).then((utxos) => {
        this.unspents = utxos;
        this.maxAmounts = fee.getMaxAmounts(this);
        done(null, this);
      });
    }).catch(done);
  }
  async update() {
    const result = await this.getDynamicFees();
    if (result) {
      this.feeRates = result.items;
    }
  }
  loadTxs() {
    let promise = Promise.resolve();
    if (!this.historyTxIdsSorted) {
      promise = this.api.transactions.getSortedTxIds(this._txIds).then((txIds) => {
        this.historyTxIdsSorted = txIds;
      });
    }
    return promise.then(() => {
      const allAddresses = this.getAllAddresses();
      const start = this.txsCursor ? this.historyTxIdsSorted.indexOf(this.txsCursor) + 1 : 0;
      const txIds = this.historyTxIdsSorted.slice(start, start + this.txsPerPage);
      return fetchTransactions(this, allAddresses, txIds).then((txs) => {
        const hasMoreTxs = txs.length === this.txsPerPage;
        this.txsCursor = hasMoreTxs ? txs[txs.length - 1].id : undefined;
        return {
          txs,
          hasMoreTxs,
        };
      });
    });
  }
  lock() {
    Object.keys(this.accounts).forEach((type) => {
      const account = this.accounts[type];
      account.external.wipePrivateData();
      account.internal.wipePrivateData();
      account.base.wipePrivateData();
    });
    this.isLocked = true;
  }
  unlock(seed) {
    const hdkey = HDKey.fromMasterSeed(Buffer.from(seed, 'hex'), this.network.bip32);
    Object.keys(this.accounts).forEach((type) => {
      let base;
      if (type === 'p2pkh') {
        base = hdkey.derive("m/0'");
      } else if (type === 'p2sh') {
        base = hdkey.derive(this.network.bip49);
      } else if (type === 'p2wpkh') {
        base = hdkey.derive(this.network.bip84);
      }
      const account = this.accounts[type];
      account.base = base;
      account.external = base.deriveChild(0);
      account.internal = base.deriveChild(1);
    });
    this.isLocked = false;
  }
  publicKey() {
    const publicKey = {};
    Object.keys(this.accounts).forEach((type) => {
      const account = this.accounts[type];
      publicKey[type] = account.base.publicExtendedKey;
    });
    return JSON.stringify(publicKey);
  }
  getBalance() {
    return this.balance;
  }
  getMaxAmounts() {
    return this.maxAmounts;
  }
  getFeeRates() {
    return this.feeRates;
  }
  getUnspentsForTx(options = {}) {
    const utxos = options.unspents || this.unspents;
    const gap = options.gap || 0;
    return utxos.filter((unspent) => {
      return unspent.confirmations >= this.minConf;
    }).sort((o1, o2) => {
      return o2.value - o1.value;
    }).slice(0, this.maxTxInputs + gap);
  }
  getNextChangeAddress() {
    const account = this.accounts[this.addressType];
    const node = account.internal.deriveChild(account.changeAddresses.length);
    return this.getAddress(node.publicKey, this.addressType);
  }
  getNextAddress(oldFormat) {
    const account = this.accounts[this.addressType];
    const node = account.external.deriveChild(account.addresses.length);
    const address = this.getAddress(node.publicKey, this.addressType);
    if (this.networkName === 'bitcoincash' && !oldFormat) {
      return bchaddr.toCashAddress(address).split(':')[1];
    }
    return address;
  }
  getAddress(publicKeyBuffer, type) {
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
  }
  getAllAddresses() {
    const addresses = Object.keys(this.accounts).reduce((result, key) => {
      return result.concat(this.accounts[key].addresses);
    }, []);
    const changeAddresses = Object.keys(this.accounts).reduce((result, key) => {
      return result.concat(this.accounts[key].changeAddresses);
    }, []);
    return addresses.concat(changeAddresses);
  }
  exportPrivateKeys() {
    if (this.unspents.length === 0) {
      return '';
    }
    const lines = ['address,privatekey'];
    const exported = {};
    this.unspents.forEach((unspent) => {
      if (exported[unspent.address]) {
        return false;
      }
      exported[unspent.address] = true;
      let { address } = unspent;
      if (this.networkName === 'bitcoincash') {
        address = bchaddr.toCashAddress(address).split(':')[1];
      }
      lines.push(address + ',' + this.getPrivateKeyForAddress(unspent.address).toWIF(this.network));
    });
    return lines.join('\n');
  }
  getPrivateKeyForAddress(address) {
    let index;
    const types = Object.keys(this.accounts);
    for (let i = 0; i < types.length; i++) {
      const type = this.network.addressTypes[i];
      const account = this.accounts[type];
      if ((index = account.addresses.indexOf(address)) > -1) {
        return new bitcoin.ECPair(BigInteger.fromBuffer(account.external.deriveChild(index).privateKey), null, {
          network: this.network,
        });
      } else if ((index = account.changeAddresses.indexOf(address)) > -1) {
        return new bitcoin.ECPair(BigInteger.fromBuffer(account.internal.deriveChild(index).privateKey), null, {
          network: this.network,
        });
      }
    }
    throw new Error('Unknown address. Make sure the address is from the keychain and has been generated.');
  }
  createTx(to, value, fee) {
    return transaction.createTx(this, to, value, fee);
  }
  sendTx(tx, done) {
    return transaction.sendTx(this, tx, done);
  }
  createPrivateKey(wif) {
    return bitcoin.ECPair.fromWIF(wif, this.network);
  }
  createImportTx(options) {
    return transaction.createImportTx(this, options);
  }
  getImportTxOptions(privateKey) {
    return transaction.getImportTxOptions(this, privateKey);
  }
  createReplacement(tx) {
    return transaction.createReplacement(this, tx);
  }
  minimumFees(value) {
    return fee.minimumFees(this, value);
  }
  estimateFees(value, unspents) {
    return fee.estimateFees(this, value, unspents);
  }
  serialize() {
    return JSON.stringify({
      baseAccount: this.accounts.p2pkh.base.privateExtendedKey,
      addressIndex: this.accounts.p2pkh.addresses.length,
      changeAddressIndex: this.accounts.p2pkh.changeAddresses.length,
      networkName: this.networkName,
      balance: this.balance,
      unspents: this.unspents,
      minConf: this.minConf,
      maxTxInputs: this.maxTxInputs,
      replaceByFeeFactor: this.replaceByFeeFactor,
    });
  }
  static deserialize(json) {
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
  }
}

Wallet.bitcoin = bitcoin;

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
