'use strict';

const validate = require('./validator');
const feeUtils = require('./fee');
const bitcoin = require('./bitcoin');
const { fetchTransactions } = require('./api/functions');

function createTx(wallet, to, value, fee) {
  if (typeof value === 'string') value = parseInt(value);
  if (typeof fee === 'string') fee = parseInt(fee);

  const { network } = wallet;
  validate.preCreateTx(to, value, network);

  const utxos = wallet.getUnspentsForTx({ gap: 1 });
  let accum = 0;
  let subTotal = value;

  const builder = new bitcoin.TransactionBuilder(network);

  builder.addOutput(to, value);

  const maxAmount = wallet.maxAmounts.find((item) => {
    return item.value === value && item.fee === fee;
  });
  if (maxAmount) {
    feeUtils.addCsFee(wallet, builder, maxAmount.csFeeValue);
  } else {
    feeUtils.addCsFee(wallet, builder, value);
  }
  utxos.some((unspent) => {
    builder.addInputUniversal(wallet, unspent);
    accum += unspent.value;
    subTotal = value + fee;
    if (accum >= subTotal) {
      const change = accum - subTotal;
      if (change > network.dustThreshold) {
        builder.addOutput(wallet.getNextChangeAddress(), change);
      }
      return true;
    }
  });

  validate.postCreateTx({
    needed: value + fee,
    has: accum,
    hasIncludingZeroConf: wallet.balance,
    wallet,
    builder,
  });

  return {
    sign() {
      if (wallet.networkName === 'bitcoincash' || wallet.networkName === 'bitcoinsv') {
        const hashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
        builder.enableBitcoinCash(true);
        builder.inputs.forEach((input, i) => {
          builder.sign(i, wallet.getPrivateKeyForAddress(utxos[i].address), null, hashType, utxos[i].value);
        });
      } else {
        builder.inputs.forEach((input, i) => {
          builder.signUniversal(wallet.getPrivateKeyForAddress(utxos[i].address), i, utxos[i]);
        });
      }

      return builder.build();
    },
  };
}

async function sendTx(wallet, tx) {
  await wallet.api.transactions.propagate(tx.toHex());
  if (tx.replaceByFeeTx) {
    refundTx(wallet, tx.replaceByFeeTx);
  }
  return processTx(wallet, tx);
}

async function processTx(wallet, tx) {
  const nextAddress = wallet.getNextAddress(true);
  const nextChangeAddress = wallet.getNextChangeAddress();
  tx.outs.forEach((out) => {
    const address = bitcoin.address.fromOutputScript(out.script, wallet.network).toString();
    const account = wallet.accounts[wallet.addressType];
    if (nextChangeAddress === address) {
      account.changeAddresses.push(address);
    } else if (nextAddress === address) {
      account.addresses.push(address);
    }
  });

  const allAddresses = wallet.getAllAddresses();
  const historyTxs = await fetchTransactions(wallet, allAddresses, [tx.getId()]);
  const historyTx = historyTxs[0];
  wallet.balance += historyTx.amount;
  let isOutcoming = false;
  historyTx.ins.forEach((input) => {
    wallet.unspents = wallet.unspents.filter((unspent) => {
      return !(unspent.txId === input.txid && unspent.vout === input.vout && unspent.value === input.amount);
    });
    if (allAddresses.indexOf(input.addr) !== -1) {
      isOutcoming = true;
    }
  });
  historyTx.outs.forEach((output) => {
    if (output.addr && allAddresses.indexOf(output.addr) !== -1) {
      wallet.unspents.push({
        address: output.addr,
        type: bitcoin.address.getAddressType(output.addr, wallet.network),
        confirmations: historyTx.confirmations,
        txId: historyTx.id,
        value: output.amount,
        vout: output.vout,
      });
    }
  });

  if (isOutcoming) {
    wallet.balance -= historyTx.fee;
  }
  wallet.maxAmounts = [];
  wallet.maxAmounts = feeUtils.getMaxAmounts(wallet);
  if (wallet._txIds.indexOf(historyTx.id) === -1) wallet._txIds.push(historyTx.id);
  return historyTx;
}

function refundTx(wallet, historyTx) {
  const allAddresses = wallet.getAllAddresses();
  let isOutcoming = false;

  wallet.balance -= historyTx.amount;
  historyTx.ins.forEach((input) => {
    if (input.addr && allAddresses.indexOf(input.addr) !== -1) {
      wallet.unspents.push({
        address: input.addr,
        type: bitcoin.address.getAddressType(input.addr, wallet.network),
        confirmations: wallet.minConf,
        txId: input.txid,
        value: input.amount,
        vout: input.vout,
      });
    }
    if (allAddresses.indexOf(input.addr) !== -1) {
      isOutcoming = true;
    }
  });
  historyTx.outs.forEach((output) => {
    wallet.unspents = wallet.unspents.filter((unspent) => {
      return !(unspent.txId === historyTx.id && unspent.vout === output.vout && unspent.value === output.amount);
    });
    const account = wallet.accounts[output.type];
    if (account.changeAddresses[account.changeAddresses.length - 1] === output.addr) {
      account.changeAddresses.pop();
    } else if (account.addresses[account.addresses.length - 1] === output.addr) {
      account.addresses.pop();
    }
  });
  if (isOutcoming) {
    wallet.balance += historyTx.fee;
  }
}

function createImportTx(wallet, options) {
  const { network } = wallet;
  const builder = new bitcoin.TransactionBuilder(network);
  if (typeof options.fee === 'string') options.fee = parseInt(options.fee);
  const amount = options.amount - options.fee;
  if (amount < 0) {
    throw new Error('Insufficient funds');
  }
  options.unspents.forEach((unspent) => {
    builder.addInputUniversal(wallet, unspent);
  });
  builder.addOutput(options.to, amount);
  feeUtils.addCsFee(wallet, builder, amount);

  return {
    sign() {
      if (wallet.networkName === 'bitcoincash' || wallet.networkName === 'bitcoinsv') {
        const hashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
        builder.enableBitcoinCash(true);
        builder.inputs.forEach((input, i) => {
          builder.sign(i, options.privateKey, null, hashType, options.unspents[i].value);
        });
      } else {
        builder.inputs.forEach((input, i) => {
          builder.signUniversal(options.privateKey, i, options.unspents[i]);
        });
      }
      return builder.build();
    },
  };
}

function getImportTxOptions(wallet, privateKey) {
  const addresses = wallet.network.addressTypes.map((type) => {
    return wallet.getAddress(privateKey.getPublicKeyBuffer(), type);
  });
  return wallet.api.addresses.unspents(addresses).then((unspents) => {
    unspents = wallet.getUnspentsForTx({ unspents });
    const amount = unspents.reduce((total, unspent) => {
      return total + unspent.value;
    }, 0);
    return {
      privateKey,
      unspents,
      amount,
    };
  });
}

function createReplacement(wallet, tx) {
  const to = tx.outs[0].addr;
  const value = tx.outs[0].amount;
  let fee = Math.ceil(tx.minerFee * wallet.replaceByFeeFactor);
  const feePerByte = Math.ceil(tx.feePerByte * wallet.replaceByFeeFactor);

  const utxos = tx.ins.map((input) => {
    return {
      txId: input.txid,
      type: input.type,
      address: input.addr,
      vout: input.vout,
      value: input.amount,
    };
  }).concat(wallet.getUnspentsForTx({ gap: 1 }));

  const builder = new bitcoin.TransactionBuilder(wallet.network);
  builder.addOutput(to, value);

  let hasChangeAddress = tx.outs.length === 2;
  if (tx.csFee) {
    fee += (tx.csFee + wallet.csRbfFee);
    builder.addOutput(wallet.csFeeAddresses[0], tx.csFee + wallet.csRbfFee);
    hasChangeAddress = tx.outs.length === 3;
  }
  let changeAddress = wallet.getNextChangeAddress();
  if (hasChangeAddress) {
    changeAddress = tx.csFee ? tx.outs[2].addr : tx.outs[1].addr;
  }

  let accum = 0;
  let subTotal = value;

  if (!hasChangeAddress) {
    fee += feePerByte * 34;
  }

  utxos.some((unspent) => {
    builder.addInputUniversal(wallet, unspent);
    if (builder.inputs.length > tx.ins.length) {
      fee += feePerByte * 148;
    }
    accum += unspent.value;
    subTotal = value + fee;

    if (accum >= subTotal) {
      const change = accum - subTotal;
      if (change > wallet.network.dustThreshold) {
        builder.addOutput(changeAddress, change);
      } else if (hasChangeAddress) {
        return false;
      }
      return true;
    }
  });

  let needed = value + fee;
  if (hasChangeAddress) {
    needed += wallet.network.dustThreshold;
  }

  validate.postCreateTx({
    needed,
    has: accum,
    hasIncludingZeroConf: wallet.balance,
    wallet,
    builder,
  });

  return {
    amount: fee - tx.fee,
    sign() {
      builder.inputs.forEach((input, i) => {
        builder.signUniversal(wallet.getPrivateKeyForAddress(utxos[i].address), i, utxos[i]);
      });
      const newTx = builder.build();
      newTx.replaceByFeeTx = tx;
      return newTx;
    },
  };
}

module.exports = {
  createTx,
  sendTx,
  createImportTx,
  getImportTxOptions,
  createReplacement,
};
