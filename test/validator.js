var assert = require('assert')
var validate = require('../validator')
var networks = require('bitcoinjs-lib').networks

describe('validator', function(){
  describe('preCreateTx', function(){
    var network = networks.testnet

    describe('destination address validation', function(){
      var value = 1000

      it('catches invalid address', function(){
        assert.throws(function(){
          validate.preCreateTx('123', value, network)
        }, function(e) {
          assert.equal(e.message, 'Invalid address')
          assert.equal(e.details, 'Invalid checksum')
          return true
        })
      })

      it('catches address with the wrong version', function(){
        assert.throws(function(){
          validate.preCreateTx('LNjYu1akN22USK3sUrSuJn5WoLMKX5Az9B', value, network)
        }, function(e) {
          assert.equal(e.message, 'Invalid address')
          assert.equal(e.details, 'Invalid address version prefix')
          return true
        })
      })

      it('allows valid pubKeyHash address', function(){
        assert.doesNotThrow(function() {
          validate.preCreateTx('mmGUSgaP7E8ig34MG2w1HzVjgwbqJoRQQu', value, network)
        })
      })

      it('allows valid p2sh address', function(){
        assert.doesNotThrow(function() {
          validate.preCreateTx('2MvR3wixpB1usCNRugN6ufwxfT4GEFxoRhQ', value, network)
        })
      })
    })

    describe('when value is below dust threshold', function(){
      it('throws an error', function(){
        assert.throws(function() {
          validate.preCreateTx('mmGUSgaP7E8ig34MG2w1HzVjgwbqJoRQQu', 546, network)
        }, function(e) {
          assert.equal(e.message, "Invalid value")
          assert.equal(e.details, "Not above dust threshold")
          assert.equal(e.dustThreshold, 546)
          return true
        })
      })
    })
  })

  describe('postCreateTx', function(){
    describe('when there is not enough money', function(){
      it('throws an error', function(){
        assert.throws(function() {
          validate.postCreateTx(1410001, 1410000, 1410000)
        }, function(e) {
          assert.equal(e.message, "Insufficient funds")
          assert.equal(e.details, null)
          assert.equal(e.has, 1410000)
          assert.equal(e.needed, 1410001)
          return true
        })
      })

      it('when the total balance including zero conf is enough to meet the amount, it populates the error details field', function(){
        assert.throws(function() {
          validate.postCreateTx(1410001, 1410000, 1410001)
        }, function(e) {
          assert.equal(e.message, "Insufficient funds")
          assert.equal(e.details, "Additional funds confirmation pending")
          return true
        })
      })
    })
  })
})
