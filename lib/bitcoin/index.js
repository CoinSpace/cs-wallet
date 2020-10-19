'use strict';

var bitcoin = require('@coinspace/bitcoinjs-lib');
var networks = require('./networks');

// eslint-disable-next-line no-undef
bitcoin.networks = networks[process.env.COIN_NETWORK || 'mainnet'];

bitcoin.TransactionBuilder.prototype.addInputUniversal = function(wallet, unspent) {
  if (unspent.type === 'p2pkh' || unspent.type === 'p2sh') {
    return this.addInput(unspent.txId, unspent.vout);
  }
  if (unspent.type === 'p2wpkh') {
    var scriptPubKey = bitcoin.address.toOutputScript(unspent.address, wallet.network);
    return this.addInput(unspent.txId, unspent.vout, null, scriptPubKey);
  }
};

bitcoin.TransactionBuilder.prototype.signUniversal = function(keyPair, vin, unspent) {
  if (unspent.type === 'p2pkh') {
    return this.sign(vin, keyPair);
  }
  if (unspent.type === 'p2sh') {
    var pubKey = keyPair.getPublicKeyBuffer();
    var pubKeyHash = bitcoin.crypto.hash160(pubKey);
    var redeemScript = bitcoin.script.witnessPubKeyHash.output.encode(pubKeyHash);
    return this.sign(vin, keyPair, redeemScript, null, unspent.value);
  }
  if (unspent.type === 'p2wpkh') {
    return this.sign(vin, keyPair, null, null, unspent.value);
  }
};

bitcoin.address.getAddressType = function(address, network) {
  var decode;
  try {
    decode = bitcoin.address.fromBase58Check(address);
    if (decode.version === network.pubKeyHash) return 'p2pkh';
    if (decode.version === network.scriptHash) return 'p2sh';
  } catch (e) {} // eslint-disable-line no-empty

  if (!network.bech32) return '';

  try {
    decode = bitcoin.address.fromBech32(address);
    if (decode.prefix !== network.bech32) return '';
    if (decode.version === 0) {
      if (decode.data.length === 20) return 'p2wpkh';
      if (decode.data.length === 32) return 'p2wsh';
    }
  } catch (e) {} // eslint-disable-line no-empty
  return '';
};

module.exports = bitcoin;
