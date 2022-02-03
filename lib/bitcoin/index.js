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

bitcoin.TransactionBuilder.IN_SIZES = {
  p2pkh: 148, // (32 + 4) + 1 + (1 + 72 + 1 + 33) + 4 = 148
  p2pkh_uncompressed: 180, // (32 + 4) + 1 + (1 + 72 + 1 + 65) + 4 = 180
  p2sh: 91, // (((32 + 4) + 1 + 23 + 4) * 4 + (1 + 1 + 72 + 1 + 33)) / 4 = 91
  p2wpkh: 68, // (((32 + 4) + 1 + 4) * 4 + (1 + 1 + 72 + 1 + 33)) / 4
};

bitcoin.TransactionBuilder.OUT_SIZES = {
  p2pkh: 34,
  p2sh: 32,
  p2wpkh: 31,
  p2wsh: 43,
};

bitcoin.TransactionBuilder.getVBytes = function(txInfo) {
  let inputSize = 0;
  let inputCount = 0;
  let witnessCount = 0;
  Object.keys(txInfo.ins).forEach((type) => {
    if (!txInfo.ins[type]) return;
    inputCount += txInfo.ins[type];
    if (type === 'p2pkh' && txInfo.isPrivateKeyUncompressed) {
      inputSize += txInfo.ins[type] * bitcoin.TransactionBuilder.IN_SIZES['p2pkh_uncompressed'];
    } else {
      inputSize += txInfo.ins[type] * bitcoin.TransactionBuilder.IN_SIZES[type];
    }
    if (type === 'p2sh' || type === 'p2wpkh') {
      witnessCount += txInfo.ins[type];
    }
  });

  let outputSize = 0;
  let outputCount = 0;
  Object.keys(txInfo.outs).forEach((type) => {
    if (!txInfo.outs[type]) return;
    outputCount += txInfo.outs[type];
    outputSize += txInfo.outs[type] * bitcoin.TransactionBuilder.OUT_SIZES[type];
  });

  let witnessVBytes = 0;
  if (witnessCount > 0) {
    witnessVBytes = 0.25 + 0.25 + getSizeOfVarInt(witnessCount) / 4;
  }
  const overheadVBytes = 4 + getSizeOfVarInt(inputCount) + getSizeOfVarInt(outputCount) + 4 + witnessVBytes;
  const vBytes = overheadVBytes + inputSize + outputSize;
  function getSizeOfVarInt(length) {
    if (length < 253) {
      return 1;
    } else if (length < 65535) {
      return 3;
    }
  }
  return Math.ceil(vBytes);
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
