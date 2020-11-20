'use strict';

var validate = require('./validator');
var feeUtils = require('./fee');
var bitcoin = require('./bitcoin');
var fetchTransactions = require('./api/functions').fetchTransactions;

function createTx(wallet, to, value, fee) {
  if (typeof value === 'string') value = parseInt(value);
  if (typeof fee === 'string') fee = parseInt(fee);

  var network = wallet.network;
  validate.preCreateTx(to, value, network);

  var utxos = wallet.getUnspentsForTx({gap: 1});
  var accum = 0;
  var subTotal = value;

  var builder = new bitcoin.TransactionBuilder(network);

  builder.addOutput(to, value);

  var maxAmount = wallet.maxAmounts.find(function(item) {
    return item.value === value && item.fee === fee;
  });
  if (maxAmount) {
    feeUtils.addCsFee(wallet, builder, maxAmount.csFeeValue);
  } else {
    feeUtils.addCsFee(wallet, builder, value);
  }
  utxos.some(function(unspent) {
    builder.addInputUniversal(wallet, unspent);
    accum += unspent.value;
    subTotal = value + fee;
    if (accum >= subTotal) {
      var change = accum - subTotal;
      if (change > network.dustThreshold) {
        builder.addOutput(wallet.getNextChangeAddress(), change);
      }
      return true;
    }
  });

  validate.postCreateTx({
    needed: value + fee,
    has: accum,
    hasIncludingZeroConf: wallet.getBalance(),
    wallet: wallet,
    builder: builder
  });

  return {
    sign: function() {
      if (wallet.networkName === 'bitcoincash' || wallet.networkName === 'bitcoinsv') {
        var hashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
        builder.enableBitcoinCash(true);
        builder.inputs.forEach(function(input, i) {
          builder.sign(i, wallet.getPrivateKeyForAddress(utxos[i].address), null, hashType, utxos[i].value);
        });
      } else {
        builder.inputs.forEach(function(input, i) {
          builder.signUniversal(wallet.getPrivateKeyForAddress(utxos[i].address), i, utxos[i]);
        });
      }

      return builder.build();
    }
  };
}

function sendTx(wallet, tx, done) {
  wallet.api.transactions.propagate(tx.toHex()).then(function() {
    if (tx.replaceByFeeTx) refundTx(wallet, tx.replaceByFeeTx);
    return processTx(wallet, tx);
  }).then(function(historyTx) {
    done(null, historyTx);
  }).catch(done);
}

function processTx(wallet, tx) {

  var nextAddress = wallet.getNextAddress(true);
  var nextChangeAddress = wallet.getNextChangeAddress();
  tx.outs.forEach(function(out) {
    var address = bitcoin.address.fromOutputScript(out.script, wallet.network).toString();
    var account = wallet.accounts[wallet.addressType];
    if (nextChangeAddress === address) {
      account.changeAddresses.push(address);
    } else if (nextAddress === address) {
      account.addresses.push(address);
    }
  });

  var allAddresses = wallet.getAllAddresses();

  return fetchTransactions(wallet, allAddresses, [tx.getId()]).then(function(historyTxs) {
    var historyTx = historyTxs[0];
    wallet.balance += historyTx.amount;
    var isOutcoming = false;
    historyTx.ins.forEach(function(input) {
      wallet.unspents = wallet.unspents.filter(function(unspent) {
        return !(unspent.txId === input.txid && unspent.vout === input.vout && unspent.value === input.amount);
      });
      if (allAddresses.indexOf(input.addr) !== -1) {
        isOutcoming = true;
      }
    });
    historyTx.outs.forEach(function(output) {
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
  });
}

function refundTx(wallet, historyTx) {
  var allAddresses = wallet.getAllAddresses();
  var isOutcoming = false;

  wallet.balance -= historyTx.amount;
  historyTx.ins.forEach(function(input) {
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
  historyTx.outs.forEach(function(output) {
    wallet.unspents = wallet.unspents.filter(function(unspent) {
      return !(unspent.txId === historyTx.id && unspent.vout === output.vout && unspent.value === output.amount);
    });
    var account = wallet.accounts[output.type];
    var changeAddresseIndex = account.changeAddresses.indexOf(output.addr);
    var adressIndex = account.addresses.indexOf(output.addr);
    if (changeAddresseIndex !== -1) {
      account.changeAddresses.splice(changeAddresseIndex, 1);
    } else if (adressIndex !== -1) {
      account.addresses.splice(adressIndex, 1);
    }
  });
  if (isOutcoming) {
    wallet.balance += historyTx.fee;
  }
}

function createImportTx(wallet, options) {
  var network = wallet.network;
  var builder = new bitcoin.TransactionBuilder(network);
  if (typeof options.fee === 'string') options.fee = parseInt(options.fee);
  var amount = options.amount - options.fee;
  if (amount < 0) {
    throw new Error('Insufficient funds');
  }
  options.unspents.forEach(function(unspent) {
    builder.addInputUniversal(wallet, unspent);
  });
  builder.addOutput(options.to, amount);
  feeUtils.addCsFee(wallet, builder, amount);

  return {
    sign: function() {
      if (wallet.networkName === 'bitcoincash' || wallet.networkName === 'bitcoinsv') {
        var hashType = bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143;
        builder.enableBitcoinCash(true);
        builder.inputs.forEach(function(input, i) {
          builder.sign(i, options.privateKey, null, hashType, options.unspents[i].value);
        });
      } else {
        builder.inputs.forEach(function(input, i) {
          builder.signUniversal(options.privateKey, i, options.unspents[i]);
        });
      }
      return builder.build();
    }
  };
}

function getImportTxOptions(wallet, privateKey) {
  var addresses = wallet.network.addressTypes.map(function(type) {
    return wallet.getAddress(privateKey.getPublicKeyBuffer(), type);
  });
  return wallet.api.addresses.unspents(addresses).then(function(unspents) {
    unspents = wallet.getUnspentsForTx({unspents: unspents});
    var amount = unspents.reduce(function(total, unspent) {
      return total + unspent.value;
    }, 0);
    return {
      privateKey: privateKey,
      unspents: unspents,
      amount: amount
    };
  });
}

function createReplacement(wallet, tx) {
  var to = tx.outs[0].addr;
  var value = tx.outs[0].amount;
  var fee = Math.ceil(tx.minerFee * wallet.replaceByFeeFactor) + tx.csFee;

  var utxos = tx.ins.map(function(input) {
    return {
      txId: input.txid,
      type: input.type,
      address: input.addr,
      vout: input.vout,
      value: input.amount,
    };
  }).concat(wallet.getUnspentsForTx({gap: 1}));

  var builder = new bitcoin.TransactionBuilder(wallet.network);
  builder.addOutput(to, value);

  var changeAddressIndex = tx.outs.length - 1;
  if (tx.csFee) {
    builder.addOutput(tx.outs[1].addr, tx.outs[1].amount);
    changeAddressIndex = 2;
  }
  var changeAddress = tx.outs[changeAddressIndex] ? tx.outs[changeAddressIndex].addr : wallet.getNextChangeAddress();

  var accum = 0;
  var subTotal = value;

  utxos.some(function(unspent) {
    builder.addInputUniversal(wallet, unspent);
    accum += unspent.value;
    subTotal = value + fee;
    if (accum >= subTotal) {
      var change = accum - subTotal;
      if (change > wallet.network.dustThreshold) {
        builder.addOutput(changeAddress, change);
      }
      return true;
    }
  });

  validate.postCreateTx({
    needed: value + fee,
    has: accum,
    hasIncludingZeroConf: wallet.getBalance(),
    wallet: wallet,
    builder: builder
  });

  return {
    amount: fee - tx.fee,
    sign: function() {
      builder.inputs.forEach(function(input, i) {
        builder.signUniversal(wallet.getPrivateKeyForAddress(utxos[i].address), i, utxos[i]);
      });
      var newTx = builder.build();
      newTx.replaceByFeeTx = tx;
      return newTx;
    }
  };
}

module.exports = {
  createTx: createTx,
  sendTx: sendTx,
  createImportTx: createImportTx,
  getImportTxOptions: getImportTxOptions,
  createReplacement: createReplacement
};
