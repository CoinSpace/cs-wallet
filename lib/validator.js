var assert = require('assert')
var bitcoin = require('bitcoinjs-lib')

function preCreateTx(to, value, network) {
  var error

  try{
    var address = bitcoin.Address.fromBase58Check(to)
    assert(address.version === network.pubKeyHash || address.version === network.scriptHash,
           'Invalid address version prefix')
  } catch(e) {
    error = new Error('Invalid address')
    error.details = e.message
    throw error
  }

  if(value <= network.dustThreshold) {
    error = new Error('Invalid value')
    error.details = 'Not above dust threshold'
    error.dustThreshold = network.dustThreshold
    throw error
  }
}

function postCreateTx(needed, has, hasIncludingZeroConf) {
  if(has < needed) {
    var error = new Error('Insufficient funds')
    error.has = has
    error.needed = needed

    if(hasIncludingZeroConf >= needed) {
      error.details = 'Additional funds confirmation pending'
    }
    throw error
  }
}

function utxos(utxos) {
  assert(Array.isArray(utxos), 'Expect utxos to be an array')
  utxos.forEach(function(unspent) {
    assert(unspent.txId != null && typeof unspent.txId === 'string', 'Expect every utxo has a txId field (string)')
    assert(unspent.address != null && typeof unspent.address === 'string', 'Expect every utxo has an address field (string)')
    assert(unspent.value != null && typeof unspent.value === 'number', 'Expect every utxo has an value field (number)')
    assert(unspent.vout != null && typeof unspent.vout === 'number', 'Expect every utxo has a vout field (number)')
    assert(unspent.confirmations != null && typeof unspent.confirmations === 'number', 'Expect every utxo has a confirmations field (number)')
  })
}

module.exports = {
  preCreateTx: preCreateTx,
  postCreateTx: postCreateTx,
  utxos: utxos
}
