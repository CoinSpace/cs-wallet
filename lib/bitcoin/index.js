'use strict';

const bitcoin = require('@coinspace/bitcoinjs-lib');
const networks = require('./networks');

// eslint-disable-next-line no-undef
bitcoin.networks = networks[process.env.COIN_NETWORK || 'mainnet'];

bitcoin.TransactionBuilder.prototype.addInputUniversal = function(wallet, unspent) {
  let sequence = bitcoin.Transaction.DEFAULT_SEQUENCE;
  if (wallet.replaceByFeeEnabled) {
    sequence = bitcoin.Transaction.DEFAULT_SEQUENCE - 2;
  }
  if (unspent.type === 'p2pkh' || unspent.type === 'p2sh') {
    return this.addInput(unspent.txId, unspent.vout, sequence);
  }
  if (unspent.type === 'p2wpkh') {
    const scriptPubKey = bitcoin.address.toOutputScript(unspent.address, wallet.network);
    return this.addInput(unspent.txId, unspent.vout, sequence, scriptPubKey);
  }
};

bitcoin.TransactionBuilder.prototype.signUniversal = function(keyPair, vin, unspent) {
  if (unspent.type === 'p2pkh') {
    return this.sign(vin, keyPair);
  }
  if (unspent.type === 'p2sh') {
    const pubKey = keyPair.getPublicKeyBuffer();
    const pubKeyHash = bitcoin.crypto.hash160(pubKey);
    const redeemScript = bitcoin.script.witnessPubKeyHash.output.encode(pubKeyHash);
    return this.sign(vin, keyPair, redeemScript, null, unspent.value);
  }
  if (unspent.type === 'p2wpkh') {
    return this.sign(vin, keyPair, null, null, unspent.value);
  }
};

bitcoin.TransactionBuilder.prototype.__overMaximumFees = function() {
  return false;
};

bitcoin.address.getAddressType = function(address, network) {
  let decode;
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
