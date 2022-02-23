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

function getAPI(request, apiNode, network) {
  return new API(request, `${apiNode}api/v1/`, network);
}

const TYPES = {
  p2pkh: 'bip44',
  p2sh: 'bip49',
  p2wpkh: 'bip84',
};

class Wallet {
  constructor(options) {
    if (!options) {
      return this;
    }
    this.crypto = options.crypto;
    // local cache
    this.cache = options.cache;
    // synchronized settings
    this.settings = options.settings || {};
    this.network = bitcoin.networks[this.crypto.platform];
    this.request = options.request;
    this.apiWeb = options.apiWeb;
    this.apiNode = options.apiNode;
    this.api = getAPI(this.request, this.apiNode, this.network);
    this.historyTxIdsSorted = undefined;
    this.txsPerPage = options.txsPerPage || 5;
    this.txsCursor = undefined;
    this.unspents = [];
    this.isLocked = !options.seed;
    this.balance = this.cache.get('balance') || 0;
    this.accounts = {};

    for (const type of this.network.addressTypes) {
      if (type === 'p2pkh') {
        this.settings.bip44 = this.settings.bip44 || "m/0'";
      } else if (type === 'p2sh') {
        this.settings.bip49 = this.settings.bip49 || this.network.bip49;
      } else if (type === 'p2wpkh') {
        this.settings.bip84 = this.settings.bip84 || this.network.bip84;
      }
    }

    if (options.seed) {
      const hdkey = HDKey.fromMasterSeed(Buffer.from(options.seed, 'hex'), this.network.bip32);
      for (const type of this.network.addressTypes) {
        const base = hdkey.derive(this.settings[TYPES[type]]);
        this.accounts[type] = {
          external: base.deriveChild(0),
          internal: base.deriveChild(1),
          base,
          addresses: [],
          changeAddresses: [],
        };
      }
    } else if (options.publicKey) {
      const publicKey = JSON.parse(options.publicKey);
      // TODO check publicKey.path
      for (const type of this.network.addressTypes) {
        const extendedKey = publicKey[type] || publicKey.p2pkh;
        const base = HDKey.fromExtendedKey(extendedKey.xpub ? extendedKey.xpub : extendedKey, this.network.bip32);
        this.accounts[type] = {
          external: base.deriveChild(0),
          internal: base.deriveChild(1),
          base,
          addresses: [],
          changeAddresses: [],
        };
      }
    } else {
      throw new Error('seed or publicKey should be passed');
    }

    this._addressType = this.cache.get('addressType')
      || (['bitcoin', 'litecoin'].includes(this.crypto.platform) ? 'p2wpkh' : 'p2pkh');

    this.addressTypes = this.network.addressTypes;
    this.minConf = options.minConf || 0;
    this.maxTxInputs = options.maxTxInputs || 650; // ~100kb
    this.feeRates = [{
      name: 'minimum',
      value: this.network.feePerByte,
      default: true,
    }];
    this.replaceByFeeFactor = options.replaceByFeeFactor || 1.5;
    this.replaceByFeeEnabled = this.crypto.platform === 'bitcoin';
    this.maxAmounts = [];
    this.csFee = 0;
    this.csMinFee = 0;
    this.csMaxFee = 0;
    this.csRbfFee = 0;
    this.csFeeAddresses = [];
    this.csFeeOff = false;
    this._txIds = [];
  }
  get addressType() {
    return this._addressType;
  }
  set addressType(value) {
    this.cache.set('addressType', value);
    this._addressType = value;
  }
  getDynamicFees() {
    return this.request({
      baseURL: this.apiWeb,
      url: 'api/v3/fees',
      params: {
        crypto: this.crypto._id,
      },
    }).catch(console.error);
  }
  getCsFee() {
    return this.request({
      baseURL: this.apiWeb,
      url: 'api/v3/csfee',
      params: {
        crypto: this.crypto._id,
      },
    }).catch(console.error);
  }
  async load() {
    this.balance = 0;
    this._txIds = [];
    this.historyTxIdsSorted = undefined;
    this.txsCursor = undefined;
    const results = await Promise.all([
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
            this.cache.set(`deriveIndex.${type}`, data.addresses.length);
            this.accounts[type].changeAddresses = data.changeAddresses;
            this.balance += data.balance;
            this._txIds = this._txIds.concat(data.txIds);
            return unspentAddresses.concat(data.unspentAddresses);
          });
        });
      }, Promise.resolve([])),
    ]);

    this.cache.set('balance', this.balance);

    if (results[0]) {
      this.feeRates = results[0].items;
    }
    if (results[1]) {
      this.csFee = results[1].fee;
      this.csMinFee = results[1].minFee;
      this.csMaxFee = results[1].maxFee;
      this.csRbfFee = results[1].rbfFee;
      this.csSkipMinFee = results[1].skipMinFee || false;
      this.csFeeAddresses = results[1].addresses;
      const whitelist = results[1].whitelist || [];
      const firstAddress = this.getAddress(this.accounts.p2pkh.external.deriveChild(0).publicKey, 'p2pkh');
      this.csFeeOff = whitelist.indexOf(firstAddress) !== -1;
    }
    this._txIds = this._txIds.filter((item, i) => {
      return this._txIds.indexOf(item) === i;
    });
    const unspentAddresses = results[2];
    const utxos = await fetchUnspents(this, unspentAddresses);
    this.unspents = utxos;
    fee.setMaxAmounts(this);
  }
  async update() {
    const result = await this.getDynamicFees();
    if (result) {
      this.feeRates = result.items;
      fee.setMaxAmounts(this);
    }
  }
  async loadTxs() {
    if (!this.historyTxIdsSorted) {
      this.historyTxIdsSorted = await this.api.transactions.getSortedTxIds(this._txIds);
    }
    const allAddresses = this.getAllAddresses();
    const start = this.txsCursor ? this.historyTxIdsSorted.indexOf(this.txsCursor) + 1 : 0;
    const txIds = this.historyTxIdsSorted.slice(start, start + this.txsPerPage);
    const txs = await fetchTransactions(this, allAddresses, txIds);
    const hasMoreTxs = txs.length === this.txsPerPage;
    this.txsCursor = hasMoreTxs ? txs[txs.length - 1].id : undefined;
    return {
      txs,
      hasMoreTxs,
    };
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
      const base = hdkey.derive(this.settings[TYPES[type]]);
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
      publicKey[type] = {
        xpub: account.base.publicExtendedKey,
        path: this.settings[TYPES[type]],
      };
    });
    return JSON.stringify(publicKey);
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
  getNextChangeAddress({ addressType = this.addressType } = {}) {
    const account = this.accounts[addressType];
    const node = account.internal.deriveChild(account.changeAddresses.length);
    return this.getAddress(node.publicKey, addressType);
  }
  getNextAddress({ addressType = this.addressType, oldFormat = false } = {}) {
    const cacheKey = `deriveIndex.${addressType}`;
    const account = this.accounts[addressType];
    const deriveIndex = this.cache.get(cacheKey) || account.addresses.length;
    const node = account.external.deriveChild(deriveIndex);
    const address = this.getAddress(node.publicKey, addressType);
    if (this.crypto.platform === 'bitcoin-cash' && !oldFormat) {
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
      if (this.crypto.platform === 'bitcoin-cash') {
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
  sendTx(tx) {
    return transaction.sendTx(this, tx);
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
  estimateFees(value, options) {
    return fee.estimateFees(this, value, options);
  }
  txUrl(txId) {
    return this.network.txUrl.replace('${txId}', txId);
  }
  toLegacyAddress(address) {
    if (this.crypto.platform !== 'bitcoin-cash') return;
    try {
      return bchaddr.toLegacyAddress(address);
    // eslint-disable-next-line no-empty
    } catch (err) {}
  }
  serialize() {
    return JSON.stringify({
      baseAccount: this.accounts.p2pkh.base.privateExtendedKey,
      addressIndex: this.accounts.p2pkh.addresses.length,
      changeAddressIndex: this.accounts.p2pkh.changeAddresses.length,
      crypto: this.crypto,
      apiNode: this.apiNode,
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
    const network = bitcoin.networks[deserialized.crypto.platform];
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
    wallet.cache = { get: () => {}, set: () => {} };
    wallet.addressType = deserialized.addressType;
    wallet.addressTypes = deserialized.addressTypes;
    wallet.crypto = deserialized.crypto;
    wallet.network = network;
    wallet.api = getAPI(deserialized.apiNode, network);
    wallet.balance = deserialized.balance;
    wallet.unspents = deserialized.unspents;
    wallet.minConf = deserialized.minConf;
    wallet.maxTxInputs = deserialized.maxTxInputs;
    wallet.replaceByFeeFactor = deserialized.replaceByFeeFactor;
    wallet.replaceByFeeEnabled = deserialized.crypto.platform === 'bitcoin';
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
Wallet.networks = bitcoin.networks;

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
