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

module.exports = {
  preCreateTx: preCreateTx,
  postCreateTx: postCreateTx
}
