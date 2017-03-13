var assert = require('assert')
var API = require('cs-blockr')
var sinon = require('sinon')
var TxGraph = require('bitcoin-tx-graph')
var bitcoin = require('bitcoinjs-lib')
var Transaction = bitcoin.Transaction
var TransactionBuilder = bitcoin.TransactionBuilder
var HDNode = bitcoin.HDNode
var Address = bitcoin.Address
var testnet = bitcoin.networks.testnet
var bufferutils = bitcoin.bufferutils
var fixtures = require('./wallet')
var addressFixtures = require('./addresses')
var balanceFixtures = require('./balance')
var history = require('./history')
var rewire = require('rewire')
var Wallet = require('../')

var noop = function() {}

describe('Common Blockchain Wallet', function() {
  var externalAccount
  var internalAccount

  before(function() {
    externalAccount = "tprv8eTJwLvUafTQT1irF54EtaYbzakkbvDaAiP3FfHzpfLiamKqGSJDzG2pQfXQDWVWmmHhM3ERRdeG7V2b7aYNZWKy8UYNQL511sWZuUNNBNR"
    internalAccount = "tprv8eTJwLvUafTQVZgNArJSWQgwu6vtBgEzB9LACG4GPhwofFCSaCMzqj5eYqmZ1qmTJVmsa82EfUqkdpUtMmnKp5RJaUdc1KCjzSUc3nRsoXf"
  })

  describe('process env', function() {
    describe('', function() {
      var apiUrl = null

      beforeEach(function() {
        Wallet = rewire('../lib/wallet')
        Wallet.__set__('getAPI', function(network, apiWrapperUrl) {
          apiUrl = apiWrapperUrl

          return {
            addresses: {
              summary: noop
            }
          }
        })
      })

      it('should setup wrapper api url by process env', function() {
        process.env.API_WRAPPER_URL = 'hello-world'
        new Wallet(externalAccount, internalAccount)
        process.env.API_WRAPPER_URL = undefined
        assert.equal(apiUrl, 'hello-world')
      })

      afterEach(function() {
        Wallet = require('../')
      })
    })

    it('should setup insight API wrapper if it is define in process env', function(done) {
      this.timeout(100000)
      process.env.API_WRAPPER = 'insight'
      var wallet = new Wallet(externalAccount, internalAccount, 'testnet', function() {
        done()
      })
      assert(wallet.api instanceof require('cs-insight'))
    })

    it('should setup blockr API wrapper by default', function(done) {
      this.timeout(100000)
      process.env.API_WRAPPER = ''
      var wallet = new Wallet(externalAccount, internalAccount, 'testnet', function() {
        done()
      })
      assert(wallet.api instanceof require('cs-blockr'))
    })
  })

  describe('network dependent tests', function() {
    this.timeout(100000)
    var wallet
    var addresses = ["n2DTZtbDbNAX315g3vtUdLKLWeAGtLUKd5","n3Ry7ra8hFmhPWdFJJNY5YBFNyED8T2F6L","mjuRrrDwYY4qfK5Cea3PcaqE1Wix7ieBWM"]
    var changeAddresses = ['mk1iSBkdVGkj4rHsgvnNj78sViw8Pq2KBY', 'n4QqWKg6kzgDGtLybDcHCMVPLZuJgT3MZr', 'mk3vi2jCLzzxCUMxvrgL2zumS3CQGedWqN', 'mhoDWJcxYfmKAu57trrhaG9uHWPx5q8W9z', 'mqsxmdRAZ52UUbmrsovDvLuAmFxyXFiaE5', 'mtmw3orgdjNhCJSCCVMLFMf38txz6CzHB9', 'n38DfSrxRr9BoydsXt6NpQDUWAhZCoGWkb', 'muAYGwrAkM4iAAWyGWt9bvat6hGiYAaN1t']

    process.env.API_WRAPPER = ''

    before(function(done) {
      wallet = new Wallet(externalAccount, internalAccount, 'testnet', done)
    })

    describe('constructor', function() {
      it('returns error when externalAccount and internalAccount are missing', function(done) {
        new Wallet(null, null, 'testnet', function(err) {
          assert(err)
          done()
        })
      })

      it('allows a balance done callback to be specified as the last argument', function(done) {
        var myWallet = new Wallet(HDNode.fromBase58(externalAccount),
                   HDNode.fromBase58(internalAccount),
                   'testnet',
                   function() {}, // the done callback
                   function() {}, // the unspents done callback
                   function(err, balance) { // the balance done callback
                     assert.ifError(err)
                     assert(!isNaN(balance))
                     assert(balance > 0)
                     assert.equal(balance, parseInt(balance, 10)) // in satoshi

                     assert(Array.isArray(myWallet.addresses))
                     assert(myWallet.addresses.length > 0)
                     assert(Array.isArray(myWallet.changeAddresses))
                     assert(myWallet.changeAddresses.length > 0)

                     done()
                   })
      })

      it('allows a unspents done callback to be specified as the second last argument', function(done) {
        new Wallet(HDNode.fromBase58(externalAccount),
                   HDNode.fromBase58(internalAccount),
                   'testnet',
                   function() {}, // the done callback
                   function(err, utxos) {
                     assert.ifError(err)
                     assert(Array.isArray(utxos))
                     assert(utxos.length > 0)
                     assert.equal(utxos[0].value, parseInt(utxos[0].value, 10)) // in satoshi
                     done()
                   },
                   function() {}) // the balance done callback
      })

      it('accepts externalAccount and internalAccount as objects', function() {
        new Wallet(HDNode.fromBase58(externalAccount),
                   HDNode.fromBase58(internalAccount),
                   'testnet',
                   function(err, w) {
                     assert.ifError(err)
                     assert.equal(w.externalAccount.toBase58(), externalAccount)
                     assert.equal(w.internalAccount.toBase58(), internalAccount)
                   })
      })

      describe('wallet properties', function() {
        it('initializes a txGraph', function() {
          assert(wallet.txGraph)
          assert.equal(wallet.txGraph.heads.length, 1)
        })

        it('assigns externalAccount and internalAccount', function() {
          assert.equal(wallet.externalAccount.toBase58(), externalAccount)
          assert.equal(wallet.internalAccount.toBase58(), internalAccount)
        })

        it('assigns addresses and changeAddresses', function() {
          assert.deepEqual(wallet.addresses, addresses)
          assert.deepEqual(wallet.changeAddresses, changeAddresses)
        })

        it('assigns networkName', function() {
          assert.equal(wallet.networkName, 'testnet')
        })

        it('assigns api', function() {
          assert(wallet.api instanceof API)
          assert.equal(wallet.api.getProxyURL(), undefined)
        })

        it('api uses a proxy url passed in as an environment variable (blockr)', function(done) {
          var url = 'https://proxy.coin.space/?url='
          process.env.BLOCKR_PROXY_URL = url
          var wallet = new Wallet(externalAccount, internalAccount, 'testnet', function(err, w) {
            process.env.BLOCKR_PROXY_URL = undefined
            assert.ifError(err)

            assert.equal(wallet.api.getProxyURL(), url)
            done()
          })
        })

        it('assigns txMetadata', function() {
          var txIds = wallet.txGraph.getAllNodes().filter(function(n) {
            return n.tx != null
          }).map(function(n) { return n.id })
          assert.deepEqual(Object.keys(wallet.txMetadata).sort(), txIds.sort())

          for(var key in wallet.txMetadata) {
            assert.equal(typeof wallet.txMetadata[key].confirmations, 'number')
            assert.equal(typeof wallet.txMetadata[key].timestamp, 'number')
          }
        })
      })
    })

    describe('serialization & deserialization', function() {
      it('works', function() {
        var parsed = Wallet.deserialize(wallet.serialize())

        assert.equal(parsed.txGraph.heads.length, wallet.txGraph.heads.length)
        assert.equal(parsed.txGraph.heads[0].id, wallet.txGraph.heads[0].id)
        assert.equal(parsed.externalAccount.toBase58(), wallet.externalAccount.toBase58())
        assert.equal(parsed.internalAccount.toBase58(), wallet.internalAccount.toBase58())
        assert.equal(parsed.addressIndex, wallet.addressIndex)
        assert.equal(parsed.changeAddressIndex, wallet.changeAddressIndex)
        assert.equal(parsed.networkName, wallet.networkName)
        assert.equal(typeof parsed.api, typeof wallet.api)
        assert.deepEqual(parsed.txMetadata, wallet.txMetadata)
      })
    })
  })

  describe('non-network dependent tests', function() {
    var readOnlyWallet
    var addresses = addressFixtures.addresses
    var changeAddresses = addressFixtures.changeAddresses

    before(function() {
      // this should be treated as a convenient read-only wallet
      readOnlyWallet = Wallet.deserialize(JSON.stringify(fixtures))
    })

    describe('getBalance', function() {
      it('works', function() {
        assert.equal(readOnlyWallet.getBalance(), 0)
      })

      it('calculates it correctly when one of the head transactions has value 0', function() {
        var myWallet = Wallet.deserialize(JSON.stringify(fixtures))
        var fundingTx = fundAddressZero(myWallet, 200000)

        var tx = new Transaction()
        tx.addInput(fundingTx, 0)
        tx.addOutput(myWallet.changeAddresses[0], 200000)

        myWallet.processTx(tx)

        assert.equal(myWallet.getBalance(), 200000)
      })

      it('returns balance from txs with confirmations no less than specified minConf', function() {
        var myWallet = Wallet.deserialize(JSON.stringify(fixtures))
        fundAddressZero(myWallet, 200000)

        assert.equal(myWallet.getBalance(10342), 0)
        assert.equal(myWallet.getBalance(3), 200000)
      })

      it('does not miss pending unspents', function() {
        var myWallet = Wallet.deserialize(JSON.stringify(balanceFixtures))
        assert.equal(myWallet.getBalance(), 52388527)
      })

      function fundAddressZero(wallet, amount) {
        var externalAddress = 'mh8evwuteapNy7QgSDWeUXTGvFb4mN1qvs'

        var prevTx = new Transaction()
        prevTx.addInput(new Transaction(), 0)
        prevTx.addOutput(externalAddress, amount)

        var tx = new Transaction()
        tx.addInput(prevTx, 0)
        tx.addOutput(wallet.addresses[0], amount)

        wallet.processTx([{tx: tx, confirmations: 3}, {tx: prevTx}])

        return tx
      }
    })

    describe('getNextAddress', function() {
      it('works', function() {
        assert.deepEqual(readOnlyWallet.getNextAddress(), 'mk9p4BPMSTK5C5zZ3Gf6mWZNtBQyC3RC7K')
      })
    })

    describe('getNextChangeAddress', function() {
      it('works', function() {
        assert.deepEqual(readOnlyWallet.getNextChangeAddress(), 'mrsMaRK7PNQt1i9sv11Dx8ZCE6aZxDKCyi')
      })
    })

    describe('getPrivateKeyForAddress', function(){
      it('returns the private key for the given address', function(){
        assert.equal(
          readOnlyWallet.getPrivateKeyForAddress(addresses[1]).toWIF(),
          readOnlyWallet.externalAccount.derive(1).privKey.toWIF()
        )
        assert.equal(
          readOnlyWallet.getPrivateKeyForAddress(changeAddresses[0]).toWIF(),
          readOnlyWallet.internalAccount.derive(0).privKey.toWIF()
        )
      })

      it('raises an error when address is not found', function(){
        assert.throws(function() {
          readOnlyWallet.getPrivateKeyForAddress(changeAddresses[changeAddresses.length])
        }, /Unknown address. Make sure the address is from the keychain and has been generated./)
      })
    })

    describe('processTx', function() {
      var prevTx, tx, externalAddress, myWallet, nextAddress, nextChangeAddress

      before(function() {
        externalAddress = 'mh8evwuteapNy7QgSDWeUXTGvFb4mN1qvs'
        myWallet = Wallet.deserialize(JSON.stringify(fixtures))
        nextAddress = myWallet.getNextAddress()
        nextChangeAddress = myWallet.getNextChangeAddress()

        prevTx = new Transaction()
        prevTx.addInput(new Transaction(), 0)
        prevTx.addOutput(nextAddress, 200000)

        tx = new Transaction()
        tx.addInput(prevTx, 0)
        tx.addOutput(externalAddress, 50000)
        tx.addOutput(nextChangeAddress, 130000)

        myWallet.processTx([{tx: tx, confirmations: 3, timestamp: 1411008787}, {tx: prevTx}])
      })

      it('adds the tx and prevTx to graph', function() {
        var graph = myWallet.txGraph
        assert.deepEqual(graph.findNodeById(tx.getId()).tx, tx)
        assert.deepEqual(graph.findNodeById(prevTx.getId()).tx, prevTx)
      })

      it('attaches the timestamp, confirmations and calculate fees & values for tx', function() {
        var metadata = myWallet.txMetadata[tx.getId()]
        assert.equal(metadata.timestamp, 1411008787)
        assert.equal(metadata.confirmations, 3)
        assert.equal(metadata.value, -50000)
        assert.equal(metadata.fee, 20000)
      })

      describe('address derivation', function() {
        var myWalletSnapshot
        before(function() {
          myWalletSnapshot = myWallet.serialize()
        })

        after(function() {
          myWallet = Wallet.deserialize(myWalletSnapshot)
        })

        it('adds the next change address to changeAddresses if the it is used to receive funds', function() {
          assert.equal(myWallet.changeAddresses.indexOf(nextChangeAddress), myWallet.changeAddresses.length - 1)
        })

        it('adds the next address to addresses if the it is used to receive funds', function() {
          assert.equal(myWallet.addresses.indexOf(nextAddress), myWallet.addresses.length - 1)
        })

        it('does not add the same address more than once', function() {
          var nextNextAddress = myWallet.getNextAddress()

          var aTx = new Transaction()
          aTx.addInput(new Transaction(), 1)
          aTx.addOutput(nextNextAddress, 200000)

          var bTx = new Transaction()
          bTx.addInput(new Transaction(), 2)
          bTx.addOutput(nextNextAddress, 200000)

          myWallet.processTx([{tx: aTx}, {tx: bTx}])

          assert.equal(myWallet.addresses.indexOf(nextNextAddress), myWallet.addresses.length - 1)
        })

        it('loops back to check on addresses again if a next address is found used', function() {
          myWallet = Wallet.deserialize(myWalletSnapshot)
          var nextNextAddress = 'miDXKzykJqDT5d1NkKB89vSaiSHGWd2iMF'
          var nextNextNextAddress = 'mrv2ioDxV6GVEs87jPGcaigm9qhbDfetcw'

          var aTx = new Transaction()
          aTx.addInput(new Transaction(), 1)
          aTx.addOutput(nextNextAddress, 200000)

          var bTx = new Transaction()
          bTx.addInput(new Transaction(), 2)
          bTx.addOutput(nextNextNextAddress, 200000)

          myWallet.processTx([{tx: bTx}, {tx: aTx}])

          assert.equal(myWallet.addresses.indexOf(nextNextAddress), myWallet.addresses.length - 2)
          assert.equal(myWallet.addresses.indexOf(nextNextNextAddress), myWallet.addresses.length - 1)
        })
      })

      describe('when a single tx is passed in', function() {
        it('works', function() {
          var outgoingTx = new Transaction()
          outgoingTx.addInput(tx, 1)
          outgoingTx.addOutput(externalAddress, 120000)

          myWallet.processTx(outgoingTx)

          var graph = myWallet.txGraph
          assert.deepEqual(graph.findNodeById(outgoingTx.getId()).tx, outgoingTx)
          var metadata = myWallet.txMetadata[outgoingTx.getId()]
          assert.equal(metadata.confirmations, undefined)
          assert.equal(metadata.timestamp, undefined)
          assert.equal(metadata.value, -120000)
          assert.equal(metadata.fee, 10000)
        })
      })
    })

    describe('getTransactionHistory', function() {
      var actualHistory
      before(function() {
        actualHistory = readOnlyWallet.getTransactionHistory()
      })

      it('returns the expected transactions in expected order', function() {
        var txIds = actualHistory.map(function(tx) {
          return tx.getId()
        })

        var expectedIds = history.txs.map(function(tx) {
          return tx.id
        })

        assert.deepEqual(txIds, expectedIds)
      })

      it('returns the transactions with the expected values & fees', function() {
        var metadata = readOnlyWallet.txMetadata
        var actual = actualHistory.map(function(tx) {
          var id = tx.getId()
          return { id: id, fee: metadata[id].fee, value: metadata[id].value }
        })

        var expected = history.txs.map(function(tx) {
          return { id: tx.id, fee: tx.fee, value: tx.value }
        })

        assert.deepEqual(actual, expected)
      })
    })

    describe('createTx', function() {
      var to, value

      before(function(){
        to = 'mh8evwuteapNy7QgSDWeUXTGvFb4mN1qvs'
        value = 500000
      })

      describe('with utxos passed in', function() {
        var utxos = [{
          txId: '98440fe7035aaec39583f68a251602a5623d34f95dbd9f54e7bc8ff29551729f',
          address: 'mwrRQPbo9Ck2BypSWT74vfG3kEE99Aungq',
          value: 400000,
          vout: 0,
          confirmations: 3
        }, {
          txId: '97bad8569bbd71f27b562b49cc65b5fa683e96c7912fac2f9d68e343a59d570e',
          address: 'mwrRQPbo9Ck2BypSWT74vfG3kEE99Aungq',
          value: 500000,
          vout: 0,
          confirmations: 2
        }, {
          txId: '7e6be25012e2ee3450b1435d5115d68a9be1cb376e094877df12a1508f003937',
          address: 'mkGgTrTSX5szqJf2xMUY6ab7LE5wVJvNYA',
          value: 510000,
          vout: 0,
          confirmations: 1
        }, {
          txId: 'a3fa16de242caaa97d69f2d285377a04847edbab4eec13e9ff083e14f77b71c8',
          address: 'mkGgTrTSX5szqJf2xMUY6ab7LE5wVJvNYA',
          value: 520000,
          vout: 0,
          confirmations: 0
        }]

        describe('transaction outputs', function(){
          it('includes the specified address and amount', function(){
            var tx = readOnlyWallet.createTx(to, value, null, null, utxos)

            assert.equal(tx.outs.length, 2)
            var out = tx.outs[0]
            var outAddress = Address.fromOutputScript(out.script, testnet)

            assert.equal(outAddress.toString(), to)
            assert.equal(out.value, value)
          })

          describe('change', function(){
            it('uses the next change address', function(){
              var fee = 0
              var tx = readOnlyWallet.createTx(to, value, fee, null, utxos)

              assert.equal(tx.outs.length, 2)
              var out = tx.outs[1]
              var outAddress = Address.fromOutputScript(out.script, testnet)

              assert.equal(outAddress.toString(), readOnlyWallet.getNextChangeAddress())
              assert.equal(out.value, 10000)
            })

            it('skips change if it is not above dust threshold', function(){
              var fee = 9454
              var tx = readOnlyWallet.createTx(to, value, fee, null, utxos)
              assert.equal(tx.outs.length, 1)
            })
          })
        })

        describe('choosing utxo', function(){
          it('takes fees into account', function(){
            var tx = readOnlyWallet.createTx(to, value, null, null, utxos)

            assert.equal(tx.ins.length, 1)
            hash = bufferutils.reverse(new Buffer(utxos[2].txId, 'hex'))
            assert.deepEqual(tx.ins[0].hash, hash)
            assert.equal(tx.ins[0].index, 0)
          })

          it('respects specified minConf', function(){
            var tx = readOnlyWallet.createTx(to, value, null, 0, utxos)

            assert.equal(tx.ins.length, 1)
            hash = bufferutils.reverse(new Buffer(utxos[3].txId, 'hex'))
            assert.deepEqual(tx.ins[0].hash, hash)
            assert.equal(tx.ins[0].index, 0)
          })
        })

        describe('validations', function(){
          it('errors on invalid utxos', function(){
            assert.throws(function() { readOnlyWallet.createTx(to, value, null, null, {}) })
          })
        })
      })

      describe('without utxos passed in', function() {
        var address1, address2, unspentTxs

        before(function(){
          unspentTxs = []

          address1 = readOnlyWallet.addresses[0]
          address2 = readOnlyWallet.changeAddresses[0]

          var pair0 = createTxPair(address1, 400000) // not enough for value
          unspentTxs.push(pair0.tx)

          var pair1 = createTxPair(address1, 500000) // not enough for only value
          unspentTxs.push(pair1.tx)

          var pair2 = createTxPair(address2, 510000) // enough for value and fee
          unspentTxs.push(pair2.tx)

          var pair3 = createTxPair(address2, 520000) // enough for value and fee
          unspentTxs.push(pair3.tx)

          readOnlyWallet.processTx([
            {tx: pair0.tx, confirmations: 1}, {tx: pair0.prevTx},
            {tx: pair1.tx, confirmations: 1}, {tx: pair1.prevTx},
            {tx: pair2.tx, confirmations: 1}, {tx: pair2.prevTx},
            {tx: pair3.tx, confirmations: 0}, {tx: pair3.prevTx}
          ])

          function createTxPair(address, amount) {
            var prevTx = new Transaction()
            prevTx.addInput(new Transaction(), 0)
            prevTx.addOutput(to, amount)

            var tx = new Transaction()
            tx.addInput(prevTx, 0)
            tx.addOutput(address, amount)

            return { prevTx: prevTx, tx: tx }
          }
        })

        describe('transaction outputs', function(){
          it('includes the specified address and amount', function(){
            var tx = readOnlyWallet.createTx(to, value)

            assert.equal(tx.outs.length, 2)
            var out = tx.outs[0]
            var outAddress = Address.fromOutputScript(out.script, testnet)

            assert.equal(outAddress.toString(), to)
            assert.equal(out.value, value)
          })

          describe('change', function(){
            it('uses the next change address', function(){
              var fee = 0
              var tx = readOnlyWallet.createTx(to, value, fee)

              assert.equal(tx.outs.length, 2)
              var out = tx.outs[1]
              var outAddress = Address.fromOutputScript(out.script, testnet)

              assert.equal(outAddress.toString(), readOnlyWallet.getNextChangeAddress())
              assert.equal(out.value, 10000)
            })

            it('skips change if it is not above dust threshold', function(){
              var fee = 9454
              var tx = readOnlyWallet.createTx(to, value, fee)
              assert.equal(tx.outs.length, 1)
            })
          })
        })

        describe('choosing utxo', function(){
          it('takes fees into account', function(){
            var tx = readOnlyWallet.createTx(to, value)

            assert.equal(tx.ins.length, 1)
            assert.deepEqual(tx.ins[0].hash, unspentTxs[2].getHash())
            assert.equal(tx.ins[0].index, 0)
          })

          it('respects specified minConf', function(){
            var tx = readOnlyWallet.createTx(to, value, null, 0)

            assert.equal(tx.ins.length, 1)
            assert.deepEqual(tx.ins[0].hash, unspentTxs[3].getHash())
            assert.equal(tx.ins[0].index, 0)
          })
        })

        describe('transaction fee', function(){
          it('allows fee to be specified', function(){
            var fee = 30000
            var tx = readOnlyWallet.createTx(to, value, fee)

            assert.equal(getFee(tx), fee)
          })

          it('allows fee to be set to zero', function(){
            value = 510000
            var fee = 0
            var tx = readOnlyWallet.createTx(to, value, fee)

            assert.equal(getFee(tx), fee)
          })

          function getFee(tx) {
            var inputValue = tx.ins.reduce(function(memo, input){
              var id = Array.prototype.reverse.call(input.hash).toString('hex')
              var prevTx = unspentTxs.filter(function(t) {
                return t.getId() === id
              })[0]
              return memo + prevTx.outs[0].value
            }, 0)

            return tx.outs.reduce(function(memo, output){
              return memo - output.value
            }, inputValue)
          }
        })

        describe('signing', function(){
          afterEach(function(){
            TransactionBuilder.prototype.sign.restore()
            TransactionBuilder.prototype.build.restore()
          })

          it('signes the inputs with respective keys', function(){
            var fee = 30000
            sinon.stub(TransactionBuilder.prototype, "sign")
            sinon.stub(TransactionBuilder.prototype, "build")

            var tx = readOnlyWallet.createTx(to, value, fee)

            assert(TransactionBuilder.prototype.sign.calledWith(0, readOnlyWallet.getPrivateKeyForAddress(address2)))
            assert(TransactionBuilder.prototype.sign.calledWith(1, readOnlyWallet.getPrivateKeyForAddress(address1)))
            assert(TransactionBuilder.prototype.build.calledWith())
          })
        })

        describe('validations', function(){
          it('errors on invalid address', function(){
            assert.throws(function() { readOnlyWallet.createTx('123', value) })
          })

          it('errors on address with the wrong version', function(){
            assert.throws(function() { readOnlyWallet.createTx('LNjYu1akN22USK3sUrSuJn5WoLMKX5Az9B', value) })
          })

          it('errors on below dust value', function(){
            assert.throws(function() { readOnlyWallet.createTx(to, 546) })
          })

          it('errors on insufficient funds', function(){
            assert.throws(function() { readOnlyWallet.createTx(to, 1405001) })
          })
        })
      })

    })

    describe('estimateFees', function() {
      var address, to

      before(function(){
        readOnlyWallet = Wallet.deserialize(JSON.stringify(fixtures)) // reset wallet

        to = 'mh8evwuteapNy7QgSDWeUXTGvFb4mN1qvs'
        address = readOnlyWallet.addresses[0]

        var pair0 = createTxPair(address, 10000) 
        var pair1 = createTxPair(address, 50000)

        readOnlyWallet.processTx([
          {tx: pair0.tx, confirmations: 1}, {tx: pair0.prevTx},
          {tx: pair1.tx, confirmations: 1}, {tx: pair1.prevTx}
        ])

        function createTxPair(address, amount) {
          var prevTx = new Transaction()
          prevTx.addInput(new Transaction(), 0)
          prevTx.addOutput(to, amount)

          var tx = new Transaction()
          tx.addInput(prevTx, 0)
          tx.addOutput(address, amount)

          return { prevTx: prevTx, tx: tx }
        }
      })

      it('calculates it correctly with single tx input', function() {
        assert.deepEqual(readOnlyWallet.estimateFees(to, 20000, [10000]), [2260])
      })

      it('calculates it correctly with multiple tx inputs', function() {
        assert.deepEqual(readOnlyWallet.estimateFees(to, 50000, [10000, 200000]), [3740, 74800])
      })
    })

    describe('sendTx', function() {

      var tx = new Transaction()

      beforeEach(function(){
        sinon.stub(Wallet.prototype, "processTx")
      })

      it('propagates the transaction through the API', function(done) {
        sinon.stub(readOnlyWallet.api.transactions, "propagate").callsArg(1)

        readOnlyWallet.sendTx(tx, function(err) {
          assert.ifError(err)
          assert(readOnlyWallet.api.transactions.propagate.calledWith(tx.toHex()))
          done()
        })
      })

      it('processes the transaction on success', function(done) {
        sinon.stub(readOnlyWallet.api.transactions, "propagate").callsArg(1)

        readOnlyWallet.sendTx(tx, function(err) {
          assert.ifError(err)
          assert(Wallet.prototype.processTx.calledWith(tx))
          done()
        })
      })

      it('invokes callback with error on error', function(done) {
        var error = new Error('oops')
        sinon.stub(readOnlyWallet.api.transactions, "propagate").callsArgWith(1, error)

        readOnlyWallet.sendTx(tx, function(err) {
          assert.equal(err, error)
          done()
        })
      })

      afterEach(function(){
        readOnlyWallet.api.transactions.propagate.restore()
        Wallet.prototype.processTx.restore()
      })
    })
  })
})