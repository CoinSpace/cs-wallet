'use strict';

const assert = require('assert');
const sinon = require('sinon');
const Wallet = require('../');
const { bitcoin } = Wallet;
const { Transaction } = bitcoin;
const { TransactionBuilder } = bitcoin;
const Address = bitcoin.address;
const network = bitcoin.networks.bitcoin;
const fixtures = require('./wallet');
const addressFixtures = require('./addresses');
const transactionsFixtures = require('./transactions');
const wif = require('wif');
const BigInteger = require('bigi');
// eslint-disable-next-line max-len
const RANDOM_SEED = '2b48a48a752f6c49772bf97205660411cd2163fe6ce2de19537e9c94d3648c85c0d7f405660c20253115aaf1799b1c41cdd62b4cfbb6845bc9475495fc64b874';
// eslint-disable-next-line max-len
const RANDOM_SEED_PUB_KEY = 'tpubD8X9JnC6UVearYMvty3RNHgeboMFEnRusUoD5uHixU3RosJxwHg4jZGpwSnhB9mfjaFbzpyJMzpGPaxM146RWMEVRtjVVMQvv2JqPgJbKLh';

describe('wallet', () => {
  let readOnlyWallet;
  const { addresses } = addressFixtures;
  const { changeAddresses } = addressFixtures;
  const sandbox = sinon.createSandbox();

  beforeEach(() => {
    // this should be treated as a convenient read-only wallet
    readOnlyWallet = Wallet.deserialize(JSON.stringify(fixtures));
  });

  afterEach(()=> {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('with seed', () => {
      const wallet = new Wallet({
        networkName: 'bitcoin',
        seed: RANDOM_SEED,
      });
      assert.ok(wallet);
      assert.strictEqual(wallet.isLocked, false);
    });

    it('with publicKey', () => {
      const { accounts } = readOnlyWallet;
      const publicKey = {
        p2pkh: accounts.p2pkh.base.publicExtendedKey,
      };
      const wallet = new Wallet({
        networkName: 'bitcoin',
        publicKey: JSON.stringify(publicKey),
      });
      assert.strictEqual(wallet.accounts.p2pkh.base.publicExtendedKey, accounts.p2pkh.base.publicExtendedKey);
      assert.strictEqual(wallet.accounts.p2sh.base.publicExtendedKey, accounts.p2pkh.base.publicExtendedKey);
      assert.strictEqual(wallet.accounts.p2wpkh.base.publicExtendedKey, accounts.p2pkh.base.publicExtendedKey);
      assert.strictEqual(wallet.isLocked, true);
      assert.ok(wallet);
    });
  });

  describe('lock', () => {
    it('works', () => {
      const wallet = new Wallet({
        networkName: 'bitcoin',
        seed: RANDOM_SEED,
      });
      assert.strictEqual(wallet.isLocked, false);
      wallet.lock();
      Object.keys(wallet.accounts).forEach((key) => {
        const account = wallet.accounts[key];
        assert.strictEqual(account.base.privateExtendedKey, null);
        assert.strictEqual(account.external.privateExtendedKey, null);
        assert.strictEqual(account.internal.privateExtendedKey, null);
      });
      assert.strictEqual(wallet.isLocked, true);
    });
  });

  describe('unlock', () => {
    it('works', () => {
      const publicKey = {
        p2pkh: RANDOM_SEED_PUB_KEY,
      };
      const wallet = new Wallet({
        networkName: 'bitcoin',
        publicKey: JSON.stringify(publicKey),
      });
      assert.strictEqual(wallet.isLocked, true);
      wallet.unlock(RANDOM_SEED);
      Object.keys(wallet.accounts).forEach((key) => {
        const account = wallet.accounts[key];
        assert.ok(account.base.privateExtendedKey);
        assert.ok(account.external.privateExtendedKey);
        assert.ok(account.internal.privateExtendedKey);
      });
      assert.strictEqual(wallet.isLocked, false);
    });
  });

  describe('publicKey', () => {
    it('works', () => {
      const wallet = new Wallet({
        networkName: 'bitcoin',
        seed: RANDOM_SEED,
      });
      const publicKey = wallet.publicKey();
      assert.ok(publicKey);
    });

    it('key is valid', () => {
      const wallet = new Wallet({
        networkName: 'bitcoin',
        seed: RANDOM_SEED,
      });
      const publicKey = wallet.publicKey();
      const secondWalet = new Wallet({
        networkName: 'bitcoin',
        publicKey,
      });
      secondWalet.unlock(RANDOM_SEED);
      Object.keys(wallet.accounts).forEach((key) => {
        const account = wallet.accounts[key];
        const secondAccount = secondWalet.accounts[key];
        assert.strictEqual(account.base.publicExtendedKey, secondAccount.base.publicExtendedKey);
        assert.strictEqual(account.base.privateExtendedKey, secondAccount.base.privateExtendedKey);
        assert.strictEqual(account.external.publicExtendedKey, secondAccount.external.publicExtendedKey);
        assert.strictEqual(account.external.privateExtendedKey, secondAccount.external.privateExtendedKey);
        assert.strictEqual(account.internal.publicExtendedKey, secondAccount.internal.publicExtendedKey);
        assert.strictEqual(account.internal.privateExtendedKey, secondAccount.internal.privateExtendedKey);
      });
    });
  });

  describe('get balance', () => {
    it('works', () => {
      assert.strictEqual(readOnlyWallet.balance, 0);
    });

    it('calculates it correctly when one of the head transactions has value 0', async () => {
      const myWallet = Wallet.deserialize(JSON.stringify(fixtures));

      sandbox.stub(myWallet.api.transactions, 'get').resolves([transactionsFixtures.fundedAddressZero]);

      const fundingTx = await fundAddressZero(myWallet);

      myWallet.api.transactions.get.restore();
      sandbox.stub(myWallet.api.transactions, 'get').resolves([transactionsFixtures.fundedChangeAddress]);

      const tx = new Transaction();
      tx.addInput(fundingTx.getHash(), 0);
      tx.addOutput(Address.toOutputScript(myWallet.accounts.p2pkh.changeAddresses[0], network), 200000);

      sandbox.stub(myWallet.api.transactions, 'propagate').resolves();
      await myWallet.sendTx(tx).finally(() => {
        myWallet.api.transactions.propagate.restore();
      });
      assert.strictEqual(myWallet.balance, 200000);
    });

    async function fundAddressZero(wallet) {
      const tx = new Transaction();
      tx.addInput((new Transaction()).getHash(), 0);
      tx.addOutput(Address.toOutputScript(wallet.accounts.p2pkh.addresses[0], network), 200000);

      sandbox.stub(wallet.api.transactions, 'propagate').resolves();
      await wallet.sendTx(tx).finally(() => {
        wallet.api.transactions.propagate.restore();
      });
      return tx;
    }
  });

  describe('getNextAddress', () => {
    it('works', () => {
      assert.deepStrictEqual(readOnlyWallet.getNextAddress(true), 'mr7dXSfei5TQPmkJhA6cLmrwnhihaqbCUy');
    });
  });

  describe('getNextChangeAddress', () => {
    it('works', () => {
      assert.deepStrictEqual(readOnlyWallet.getNextChangeAddress(), 'mm1Y2FNfKCvvP6e67wyyxBoQkkwWXyJmDB');
    });
  });

  describe('getPrivateKeyForAddress', ()=> {
    it('returns the private key for the given address', ()=> {
      assert.strictEqual(
        readOnlyWallet.getPrivateKeyForAddress(addresses[1]).toWIF(),
        wif.encode(network.wif, readOnlyWallet.accounts.p2pkh.external.deriveChild(1).privateKey, true)
      );
      assert.strictEqual(
        readOnlyWallet.getPrivateKeyForAddress(changeAddresses[0]).toWIF(),
        wif.encode(network.wif, readOnlyWallet.accounts.p2pkh.internal.deriveChild(0).privateKey, true)
      );
    });

    it('raises an error when address is not found', ()=> {
      assert.throws(() => {
        readOnlyWallet.getPrivateKeyForAddress(changeAddresses[changeAddresses.length]);
      }, /Unknown address. Make sure the address is from the keychain and has been generated./);
    });
  });

  describe('processTx', () => {
    let tx, prevTx, externalAddress, myWallet, nextAddress, nextChangeAddress;

    before(async () => {
      externalAddress = 'mh8evwuteapNy7QgSDWeUXTGvFb4mN1qvs';
      myWallet = Wallet.deserialize(JSON.stringify(fixtures));
      nextAddress = myWallet.getNextAddress(true);

      nextChangeAddress = myWallet.getNextChangeAddress();

      prevTx = new Transaction();
      prevTx.addInput((new Transaction()).getHash(), 0);
      prevTx.addOutput(Address.toOutputScript(nextAddress, network), 200000);

      tx = new Transaction();
      tx.addInput((new Transaction()).getHash(), 0);
      tx.addOutput(Address.toOutputScript(externalAddress, network), 50000);
      tx.addOutput(Address.toOutputScript(nextChangeAddress, network), 130000);

      sandbox.stub(myWallet.api.transactions, 'get').resolves([transactionsFixtures.fundedAddressZero]);

      sandbox.stub(myWallet.api.transactions, 'propagate').resolves();

      await Promise.all([
        myWallet.sendTx(prevTx),
        myWallet.sendTx(tx),
      ]).finally(() => {
        myWallet.api.transactions.propagate.restore();
        myWallet.api.transactions.get.restore();
      });
    });

    describe('address derivation', () => {
      let myWalletSnapshot;
      before(() => {
        myWalletSnapshot = myWallet.serialize();
      });

      after(() => {
        myWallet = Wallet.deserialize(myWalletSnapshot);
      });

      it('adds the next change address to changeAddresses if the it is used to receive funds', () => {
        const expected = myWallet.accounts.p2pkh.changeAddresses.length - 1;
        assert.strictEqual(myWallet.accounts.p2pkh.changeAddresses.indexOf(nextChangeAddress), expected);
      });

      it('adds the next address to addresses if the it is used to receive funds', () => {
        const expected = myWallet.accounts.p2pkh.addresses.length - 1;
        assert.strictEqual(myWallet.accounts.p2pkh.addresses.indexOf(nextAddress), expected);
      });

      it('does not add the same address more than once', async () => {
        sandbox.stub(myWallet.api.transactions, 'get').resolves([transactionsFixtures.fundedAddressZero]);
        const nextNextAddress = myWallet.getNextAddress(true);

        const aTx = new Transaction();
        aTx.addInput((new Transaction()).getHash(), 1);
        aTx.addOutput(Address.toOutputScript(myWallet.getNextAddress(true), network), 200000);

        const bTx = new Transaction();
        bTx.addInput((new Transaction()).getHash(), 2);
        bTx.addOutput(Address.toOutputScript(myWallet.getNextAddress(true), network), 200000);

        sandbox.stub(myWallet.api.transactions, 'propagate').resolves();

        await Promise.all([
          myWallet.sendTx(aTx),
          myWallet.sendTx(bTx),
        ]).finally(() => {
          myWallet.api.transactions.propagate.restore();
        });

        const { addresses } = myWallet.accounts.p2pkh;
        assert.strictEqual(addresses.indexOf(nextNextAddress), addresses.length - 1);
      });
    });
  });

  describe('createTx', () => {
    let to, value, address1, address2, unspentTxs;

    before(() => {
      to = 'mh8evwuteapNy7QgSDWeUXTGvFb4mN1qvs';
      value = 500000;

      unspentTxs = [];

      address1 = readOnlyWallet.accounts.p2pkh.addresses[0];
      address2 = readOnlyWallet.accounts.p2pkh.changeAddresses[0];

      const pair0 = createTxPair(address1, 400000); // not enough for value
      unspentTxs.push(pair0.tx);

      const pair1 = createTxPair(address1, 500000); // not enough for only value
      unspentTxs.push(pair1.tx);

      const pair2 = createTxPair(address2, 510000); // enough for value and fee
      unspentTxs.push(pair2.tx);

      const pair3 = createTxPair(address2, 520000); // enough for value and fee
      unspentTxs.push(pair3.tx);

      function createTxPair(address, amount) {
        const prevTx = new Transaction();
        prevTx.addInput((new Transaction()).getHash(), 0);
        prevTx.addOutput(Address.toOutputScript(to, network), amount);

        const tx = new Transaction();
        tx.addInput(prevTx.getHash(), 0);
        tx.addOutput(Address.toOutputScript(address, network), amount);

        return { prevTx, tx };
      }
    });

    describe('transaction outputs', ()=> {
      it('includes the specified address and amount', ()=> {
        const tx = readOnlyWallet.createTx(to, value, 0).sign();

        assert.strictEqual(tx.outs.length, 2);
        const out = tx.outs[0];
        const outAddress = Address.fromOutputScript(out.script, network);

        assert.strictEqual(outAddress.toString(), to);
        assert.strictEqual(out.value, value);
      });

      describe('change', ()=> {
        it('uses the next change address', ()=> {
          const fee = 0;
          const tx = readOnlyWallet.createTx(to, value, fee).sign();

          assert.strictEqual(tx.outs.length, 2);
          const out = tx.outs[1];
          const outAddress = Address.fromOutputScript(out.script, network);

          assert.strictEqual(outAddress.toString(), readOnlyWallet.getNextChangeAddress());
          assert.strictEqual(out.value, 10000);
        });

        it('skips change if it is not above dust threshold', ()=> {
          const fee = 9454;
          const tx = readOnlyWallet.createTx(to, value, fee).sign();
          assert.strictEqual(tx.outs.length, 1);
        });
      });
    });

    describe('choosing utxo', ()=> {
      it('takes fees into account', ()=> {
        const tx = readOnlyWallet.createTx(to, value, 0).sign();

        assert.strictEqual(tx.ins.length, 1);
        assert.deepStrictEqual(tx.ins[0].hash, unspentTxs[2].getHash());
        assert.strictEqual(tx.ins[0].index, 0);
      });
    });

    describe('transaction fee', ()=> {
      it('allows fee to be specified', ()=> {
        const fee = 30000;
        const tx = readOnlyWallet.createTx(to, value, fee).sign();

        assert.strictEqual(getFee(tx), fee);
      });

      it('allows fee to be set to zero', ()=> {
        value = 510000;
        const fee = 0;
        const tx = readOnlyWallet.createTx(to, value, fee).sign();

        assert.strictEqual(getFee(tx), fee);
      });

      function getFee(tx) {
        const inputValue = tx.ins.reduce((memo, input)=> {
          const id = Array.prototype.reverse.call(input.hash).toString('hex');
          const prevTx = unspentTxs.filter((t) => {
            return t.getId() === id;
          })[0];
          return memo + prevTx.outs[0].value;
        }, 0);

        return tx.outs.reduce((memo, output)=> {
          return memo - output.value;
        }, inputValue);
      }
    });

    describe('signing', ()=> {
      it('signes the inputs with respective keys', ()=> {
        const fee = 30000;
        sandbox.stub(TransactionBuilder.prototype, 'sign');
        sandbox.stub(TransactionBuilder.prototype, 'build');

        readOnlyWallet.createTx(to, value, fee).sign();

        assert(TransactionBuilder.prototype.sign.calledWith(0, readOnlyWallet.getPrivateKeyForAddress(address2)));
        assert(TransactionBuilder.prototype.sign.calledWith(1, readOnlyWallet.getPrivateKeyForAddress(address1)));
        assert(TransactionBuilder.prototype.build.calledWith());
      });
    });

    describe('validations', ()=> {
      it('errors on invalid address', ()=> {
        assert.throws(() => { readOnlyWallet.createTx('123', value); });
      });

      it('errors on address with the wrong version', ()=> {
        assert.throws(() => { readOnlyWallet.createTx('LNjYu1akN22USK3sUrSuJn5WoLMKX5Az9B', value); });
      });

      it('errors on below dust value', ()=> {
        assert.throws(() => { readOnlyWallet.createTx(to, 546); });
      });

      it('errors on insufficient funds', ()=> {
        assert.throws(() => { readOnlyWallet.createTx(to, 1415001, 3740); });
      });
    });

  });

  describe('estimateFees', () => {
    before(()=> {
      readOnlyWallet = Wallet.deserialize(JSON.stringify(fixtures)); // reset wallet
    });

    it('calculates it correctly with single tx input', () => {
      assert.deepStrictEqual(readOnlyWallet.estimateFees(20000), [{
        default: true,
        estimate: 2260,
        // TODO calculate maxAmount
        maxAmount: undefined,
        name: 'minimum',
      }]);
    });

    it('calculates it correctly with multiple tx inputs', () => {
      assert.deepStrictEqual(readOnlyWallet.estimateFees(1020000), [{
        default: true,
        estimate: 5220,
        // TODO calculate maxAmount
        maxAmount: undefined,
        name: 'minimum',
      }]);
    });

    it('calculates it correctly with utxos passed in', () => {
      const utxos = [{
        txId: '98440fe7035aaec39583f68a251602a5623d34f95dbd9f54e7bc8ff29551729f',
        address: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
        value: 1520000,
        vout: 0,
        confirmations: 3,
      }];
      assert.deepStrictEqual(readOnlyWallet.estimateFees(520000, utxos), [{
        default: true,
        estimate: 2260,
        // TODO calculate maxAmount
        maxAmount: undefined,
        name: 'minimum',
      }]);
    });

    it('throws error when unspents are invalid', () => {
      assert.throws(() => {
        readOnlyWallet.estimateFees(20000, 20000, [10000], 300);
      }, (e) => {
        assert.strictEqual(e.message, 'Expect utxos to be an array');
        return true;
      });
    });
  });

  describe('sendTx', () => {

    const tx = new Transaction();

    beforeEach(()=> {
      sandbox.stub(readOnlyWallet.api.transactions, 'get').resolves([transactionsFixtures.fundedChangeAddress]);
    });

    it('propagates the transaction through the API', async () => {
      sandbox.stub(readOnlyWallet.api.transactions, 'propagate').resolves();
      await readOnlyWallet.sendTx(tx);
      assert(readOnlyWallet.api.transactions.propagate.calledWith(tx.toHex()));
    });

    it('invokes callback with error on error', async () => {
      const error = new Error('oops');
      sandbox.stub(readOnlyWallet.api.transactions, 'propagate').rejects(error);
      await assert.rejects(async () => {
        await readOnlyWallet.sendTx(tx);
      }, error);
    });
  });

  describe('createPrivateKey', () => {
    it('works', () => {
      const privateKey = readOnlyWallet.createPrivateKey('91tphZbASvHRsscCgB6TZibcSYwVNHzBX6xKvjFSMTNvzizaMyo');
      assert(privateKey instanceof bitcoin.ECPair);
    });
  });

  describe('createImportTx', () => {
    let options;

    beforeEach(() => {
      const node = readOnlyWallet.accounts.p2pkh.internal.deriveChild(0);
      const privateKey = new bitcoin.ECPair(BigInteger.fromBuffer(node.privateKey), null, {
        network,
      });
      options = {
        privateKey,
        unspents: [{
          txId: 'a3fa16de242caaa97d69f2d285377a04847edbab4eec13e9ff083e14f77b71c8',
          address: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
          value: 10000,
          vout: 0,
          type: 'p2pkh',
          confirmations: 10,
        }],
        amount: 10000,
        to: 'mo7f7vngyFkPeYsYqnubdeTJfMSxSZVSnL',
        fee: 1000,
      };
    });

    it('works', () => {
      const tx = readOnlyWallet.createImportTx(options).sign();
      assert(tx instanceof bitcoin.Transaction);
    });

    it('errors on amount less than fee', () => {
      options.fee = 20000;
      assert.throws(() => { readOnlyWallet.createImportTx(options); });
    });

  });

  describe('getImportTxOptions', () => {
    it('works', async () => {
      const unspents = [{
        txId: 'a3fa16de242caaa97d69f2d285377a04847edbab4eec13e9ff083e14f77b71c8',
        address: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
        value: 10000,
        vout: 0,
        confirmations: 10,
      },
      {
        txId: '7e6be25012e2ee3450b1435d5115d68a9be1cb376e094877df12a1508f003937',
        address: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
        value: 10000,
        vout: 0,
        confirmations: 0,
      }];
      sandbox.stub(readOnlyWallet.api.addresses, 'unspents').returns(Promise.resolve(unspents));

      const node = readOnlyWallet.accounts.p2pkh.internal.deriveChild(0);
      const privateKey = new bitcoin.ECPair(BigInteger.fromBuffer(node.privateKey), null, {
        network,
      });
      const options = await readOnlyWallet.getImportTxOptions(privateKey);
      assert.strictEqual(options.privateKey, privateKey);
      assert.strictEqual(options.amount, 10000);
      assert.strictEqual(options.unspents.length, 1);
      assert.deepStrictEqual(options.unspents[0], unspents[0]);
    });
  });

  describe('createReplacement', () => {

    function getReplacementFeePerByte(historyTx, replacement) {
      const utxos = historyTx.ins.map((input) => {
        return {
          txId: input.txid,
          type: input.type,
          address: input.addr,
          vout: input.vout,
          value: input.amount,
        };
      }).concat(readOnlyWallet.getUnspentsForTx({ gap: 1 }));
      const incoming = replacement.ins.reduce((a, x) => {
        return a + utxos.find((utxo) => {
          return utxo.txId === Buffer.from(x.hash, 'hex').reverse().toString('hex') && x.index === utxo.vout;
        }).value;
      }, 0);
      const outgoing = replacement.outs.reduce((a, x) => { return a + x.value; }, 0);
      const fee = incoming - outgoing;
      const size = replacement.ins.length * 148 + replacement.outs.length * 34 + 10;
      return Math.ceil(fee / size);
    }

    it('works (change address exist)', () => {
      const historyTx = {
        amount: -10000000,
        confirmations: 0,
        csFee: 0,
        fee: 2486,
        feePerByte: 11,
        id: '48cf58d84fcd0b94a1cf3766d1c2ec32a7789ce238c2083d990cbb797a07f451',
        ins: [{
          addr: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          address: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          amount: 100000000,
          txid: 'cb2f3955cb97941f27485c3d7ecac0932cbe3ad9ce83444a2791e950f8e9762b',
          type: 'p2pkh',
          vout: 0,
        }],
        isIncoming: false,
        isRBF: true,
        minerFee: 2486,
        outs: [
          {
            address: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
            amount: 10000000,
            vout: 0,
            type: 'p2sh',
            addr: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
          },
          {
            address: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
            amount: 89997514,
            vout: 1,
            type: 'p2pkh',
            addr: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
          },
        ],
        size: 226,
        timestamp: 1605799684000,
      };
      const replacement = readOnlyWallet.createReplacement(historyTx).sign();
      assert.strictEqual(replacement.ins.length, 1);
      assert.strictEqual(replacement.outs.length, 2);
      assert.deepStrictEqual(replacement.replaceByFeeTx, historyTx);

      assert.strictEqual(replacement.outs[0].value, historyTx.outs[0].amount);
      assert.strictEqual(Address.fromOutputScript(replacement.outs[0].script, network), historyTx.outs[0].addr);

      const replacementFeePerByte = getReplacementFeePerByte(historyTx, replacement);
      assert.strictEqual(replacementFeePerByte, Math.ceil(historyTx.feePerByte * readOnlyWallet.replaceByFeeFactor));
    });

    it('works (change address exist: persistence)', () => {
      const historyTx = {
        amount: -99995731,
        confirmations: 0,
        csFee: 0,
        fee: 2486,
        feePerByte: 11,
        id: '48cf58d84fcd0b94a1cf3766d1c2ec32a7789ce238c2083d990cbb797a07f451',
        ins: [{
          addr: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          address: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          amount: 100000000,
          txid: 'cb2f3955cb97941f27485c3d7ecac0932cbe3ad9ce83444a2791e950f8e9762b',
          type: 'p2pkh',
          vout: 0,
        }],
        isIncoming: false,
        isRBF: true,
        minerFee: 2486,
        outs: [
          {
            address: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
            amount: 99995731,
            vout: 0,
            type: 'p2sh',
            addr: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
          },
          {
            address: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
            amount: 1783,
            vout: 1,
            type: 'p2pkh',
            addr: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
          },
        ],
        size: 226,
        timestamp: 1605799684000,
      };
      const replacement = readOnlyWallet.createReplacement(historyTx).sign();

      assert.strictEqual(replacement.ins.length, 2);
      assert.strictEqual(replacement.outs.length, 2);
      assert.deepStrictEqual(replacement.replaceByFeeTx, historyTx);

      assert.strictEqual(replacement.outs[0].value, historyTx.outs[0].amount);
      assert.strictEqual(Address.fromOutputScript(replacement.outs[0].script, network), historyTx.outs[0].addr);

      const replacementFeePerByte = getReplacementFeePerByte(historyTx, replacement);
      assert.strictEqual(replacementFeePerByte, Math.ceil(historyTx.feePerByte * readOnlyWallet.replaceByFeeFactor));
    });

    it('works (change address exist: insufficient funds)', () => {
      const historyTx = {
        amount: -99935631,
        confirmations: 0,
        csFee: 0,
        fee: 2486,
        feePerByte: 11,
        id: '48cf58d84fcd0b94a1cf3766d1c2ec32a7789ce238c2083d990cbb797a07f451',
        ins: [{
          addr: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          address: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          amount: 100000000,
          txid: 'cb2f3955cb97941f27485c3d7ecac0932cbe3ad9ce83444a2791e950f8e9762b',
          type: 'p2pkh',
          vout: 0,
        }],
        isIncoming: false,
        isRBF: true,
        minerFee: 2486,
        outs: [
          {
            address: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
            amount: 99935631,
            vout: 0,
            type: 'p2sh',
            addr: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
          },
          {
            address: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
            amount: 61883,
            vout: 1,
            type: 'p2pkh',
            addr: 'myocNrhBsw92CAhoEksYLBEXBWiitfxi2D',
          },
        ],
        size: 226,
        timestamp: 1605799684000,
      };
      readOnlyWallet.replaceByFeeFactor = 200;
      assert.throws(() => {
        readOnlyWallet.createReplacement(historyTx).sign();
      }, /Insufficient funds/);
    });

    it('works (no change address)', () => {
      const historyTx = {
        amount: -99667200,
        confirmations: 0,
        csFee: 0,
        fee: 332800,
        feePerByte: 1734,
        id: '48cf58d84fcd0b94a1cf3766d1c2ec32a7789ce238c2083d990cbb797a07f451',
        ins: [{
          addr: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          address: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          amount: 100000000,
          txid: 'cb2f3955cb97941f27485c3d7ecac0932cbe3ad9ce83444a2791e950f8e9762b',
          type: 'p2pkh',
          vout: 0,
        }],
        isIncoming: false,
        isRBF: true,
        minerFee: 332800,
        outs: [
          {
            address: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
            amount: 99667200,
            vout: 0,
            type: 'p2sh',
            addr: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
          },
        ],
        size: 192,
        timestamp: 1605799684000,
      };

      const replacement = readOnlyWallet.createReplacement(historyTx).sign();

      assert.strictEqual(replacement.ins.length, 4);
      assert.strictEqual(replacement.outs.length, 1);
      assert.deepStrictEqual(replacement.replaceByFeeTx, historyTx);

      assert.strictEqual(replacement.outs[0].value, historyTx.outs[0].amount);
      assert.strictEqual(Address.fromOutputScript(replacement.outs[0].script, network), historyTx.outs[0].addr);

      const replacementFeePerByte = getReplacementFeePerByte(historyTx, replacement);
      assert.strictEqual(replacementFeePerByte, 2741);
    });

    it('works (no change address: need to add)', () => {
      const historyTx = {
        amount: -9999000,
        confirmations: 0,
        csFee: 0,
        fee: 10000,
        feePerByte: 53,
        id: '48cf58d84fcd0b94a1cf3766d1c2ec32a7789ce238c2083d990cbb797a07f451',
        ins: [{
          addr: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          address: 'n2rvmEac7zD1iknp7nkFfmqXM1pbbAoctw',
          amount: 100000000,
          txid: 'cb2f3955cb97941f27485c3d7ecac0932cbe3ad9ce83444a2791e950f8e9762b',
          type: 'p2pkh',
          vout: 0,
        }],
        isIncoming: false,
        isRBF: true,
        minerFee: 10000,
        outs: [
          {
            address: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
            amount: 99990000,
            vout: 0,
            type: 'p2sh',
            addr: 'mxDYgs7niUuoRdpmioN4ApaGqQJN3LthPN',
          },
        ],
        size: 192,
        timestamp: 1605799684000,
      };

      const replacement = readOnlyWallet.createReplacement(historyTx).sign();

      assert.strictEqual(replacement.ins.length, 2);
      assert.strictEqual(replacement.outs.length, 2);
      assert.deepStrictEqual(replacement.replaceByFeeTx, historyTx);

      assert.strictEqual(replacement.outs[0].value, historyTx.outs[0].amount);
      assert.strictEqual(Address.fromOutputScript(replacement.outs[0].script, network), historyTx.outs[0].addr);

      const replacementFeePerByte = getReplacementFeePerByte(historyTx, replacement);
      assert.strictEqual(replacementFeePerByte, Math.ceil(historyTx.feePerByte * readOnlyWallet.replaceByFeeFactor));
    });
  });

  describe('exportPrivateKeys', () => {
    it('works', () => {
      const csv = readOnlyWallet.exportPrivateKeys();
      assert.strictEqual(typeof csv, 'string');
    });

    it('errors on missing unspent address', () => {
      const myWallet = Wallet.deserialize(JSON.stringify(fixtures));
      myWallet.unspents.push('missing_address');
      assert.throws(() => {
        myWallet.exportPrivateKeys();
      }, /Unknown address. Make sure the address is from the keychain and has been generated./);
    });
  });

});
