'use strict';

const assert = require('assert');
const validate = require('../lib/validator');
const Wallet = require('../');
const { networks } = Wallet.bitcoin;
const fixtures = require('./wallet');

describe('validator', () => {
  let readOnlyWallet;
  before(() => {
    readOnlyWallet = Wallet.deserialize(JSON.stringify(fixtures));
  });

  describe('preCreateTx', ()=> {
    const network = networks.bitcoin;

    describe('destination address validation', ()=> {
      const value = 1000;

      it('catches invalid address', ()=> {
        assert.throws(()=> {
          validate.preCreateTx('123', value, network);
        }, (e) => {
          assert.strictEqual(e.message, 'Invalid address');
          return true;
        });
      });

      it('allows valid pubKeyHash address', ()=> {
        assert.doesNotThrow(() => {
          validate.preCreateTx('myYBF2Yo1LUthn3eDopEWA4a6sj4UmsWzf', value, network);
        });
      });

      it('allows valid p2sh address', ()=> {
        assert.doesNotThrow(() => {
          validate.preCreateTx('2MvR3wixpB1usCNRugN6ufwxfT4GEFxoRhQ', value, network);
        });
      });
    });

    describe('when value is below dust threshold', ()=> {
      it('throws an error', ()=> {
        assert.throws(() => {
          validate.preCreateTx('myYBF2Yo1LUthn3eDopEWA4a6sj4UmsWzf', 546, network);
        }, (e) => {
          assert.strictEqual(e.message, 'Invalid value');
          assert.strictEqual(e.details, 'Not above dust threshold');
          assert.strictEqual(e.dustThreshold, 546);
          return true;
        });
      });
    });
  });

  describe('postCreateTx', ()=> {
    describe('when transaction too large', ()=> {
      it('throws an error', () => {
        assert.throws(() => {
          validate.postCreateTx({
            wallet: readOnlyWallet,
            builder: { inputs: { length: readOnlyWallet.maxTxInputs + 1 } },
          });
        }, (e) => {
          assert.strictEqual(e.message, 'Transaction too large');
          return true;
        });
      });
    });
    describe('when there is not enough money', ()=> {
      it('throws an error', ()=> {
        assert.throws(() => {
          validate.postCreateTx({
            needed: 1420000 + 2260,
            has: 1410000,
            hasIncludingZeroConf: 1410000,
          });
        }, (e) => {
          assert.strictEqual(e.message, 'Insufficient funds');
          assert.strictEqual(e.details, undefined);
          return true;
        });
      });

      // eslint-disable-next-line max-len
      it('when the total balance including zero conf is enough to meet the amount, it populates the error details field', () => {
        assert.throws(() => {
          validate.postCreateTx({
            needed: 1410001 + 2260,
            has: 1410000,
            hasIncludingZeroConf: 1420001,
          });
        }, (e) => {
          assert.strictEqual(e.message, 'Insufficient funds');
          assert.strictEqual(e.details, 'Additional funds confirmation pending');
          return true;
        });
      });
    });
  });

  describe('utxos', ()=> {
    it('throws an error when it is not an array', ()=> {
      assert.throws(() => { validate.utxos({}); });
      assert.throws(() => { validate.utxos(1); });
      assert.throws(() => { validate.utxos('foobar'); });
    });

    ['txId', 'address', 'value', 'vout', 'confirmations'].forEach((field)=> {
      describe('when ' + field + ' is missing', ()=> {
        it('throws an error', ()=> {
          assert.throws(() => {
            const utxo = getUtxo();
            delete utxo[field];
            validate.utxos([utxo]);
          }, (e) => {
            const expectedMessage = field + ' field';
            assert(e.message.indexOf(expectedMessage) > 0,
              'expect error message to contain: ' + expectedMessage + ', but got: ' + e.message);
            return true;
          });
        });
      });
    });

    function getUtxo() {
      return {
        txId: '121954538a10eb7a59e319745b97302c2cf6ce1e159fe0de17f6038963a68fac',
        address: '1Ao9jfhQgsfHT97qsQ3GDnQ9czJnFaXNyw',
        value: 378340414,
        vout: 0,
      };
    }
  });
});
