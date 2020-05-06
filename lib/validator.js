'use strict';

var assert = require('assert');
var bitcoin = require('./bitcoin');

function preCreateTx(to, value, network) {

  validateAddress(to, network);

  if (value <= network.dustThreshold) {
    var error = new Error('Invalid value');
    error.details = 'Not above dust threshold';
    error.dustThreshold = network.dustThreshold;
    throw error;
  }
}

function postCreateTx(options) {
  if (options.builder && options.wallet && options.builder.inputs.length > options.wallet.maxTxInputs) {
    throw new Error('Transaction too large');
  }
  var needed = options.needed;
  if (options.has < needed) {
    var error = new Error('Insufficient funds');
    if (options.hasIncludingZeroConf >= needed) {
      error.details = 'Additional funds confirmation pending';
    }
    throw error;
  }
}

function utxos(utxos) {
  assert(Array.isArray(utxos), 'Expect utxos to be an array');
  utxos.forEach(function(unspent) {
    assert(unspent.txId != null && typeof unspent.txId === 'string', 'Expect every utxo has a txId field (string)');
    assert(unspent.address != null && typeof unspent.address === 'string',
      'Expect every utxo has an address field (string)');
    assert(unspent.value != null && typeof unspent.value === 'number', 'Expect every utxo has an value field (number)');
    assert(unspent.vout != null && typeof unspent.vout === 'number', 'Expect every utxo has a vout field (number)');
    assert(unspent.confirmations != null && typeof unspent.confirmations === 'number',
      'Expect every utxo has a confirmations field (number)');
  });
}

function validateAddress(addr, network) {
  var type = bitcoin.address.getAddressType(addr, network);
  if (!type) throw new Error('Invalid address');
}

module.exports = {
  preCreateTx: preCreateTx,
  postCreateTx: postCreateTx,
  utxos: utxos
};
