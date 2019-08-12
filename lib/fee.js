'use strict';
var validate = require('./validator');
var bitcoin = require('./bitcoin');

function minimumFees(wallet, value) {
  if (typeof value !== 'number') value = parseInt(value);
  var fees = [];
  for (var i = 0; i < wallet.feeRates.length; i++) {
    var csFee = getCsFee(wallet, value);
    var fee = wallet.feeRates[i].value * 226;
    fees.push(fee + csFee);
  }
  return fees;
}

function addCsFee(wallet, builder, value) {
  var fee = getCsFee(wallet, value);
  if (fee > 0) {
    builder.addOutput(wallet.csFeeAddresses[0], fee);
  }
  return fee;
}

function getCsFee(wallet, value) {
  if (wallet.csFeeOff) return 0;
  if (!wallet.csFee || !wallet.csMinFee || !wallet.csMaxFee) return 0;
  if (wallet.csFeeAddresses.length === 0) return 0;

  var network = bitcoin.networks[wallet.networkName];
  var fee = Math.max(Math.floor(value * wallet.csFee), wallet.csMinFee);
  fee = Math.min(wallet.csMaxFee, fee);

  var exportTxFee = 192 * (network.feePerKb / 1000);
  if (network.dustSoftThreshold && fee < network.dustSoftThreshold) {
    exportTxFee += network.feePerKb;
  }
  fee += exportTxFee;
  return fee;
}

function estimateFees(wallet, value, unspents) {
  if (typeof value !== 'number') value = parseInt(value);

  var minConf = wallet.minConf;
  var utxos = null;
  if (unspents != null) {
    validate.utxos(unspents);
    utxos = unspents.filter(function(unspent) {
      return unspent.confirmations >= minConf;
    });
  } else {
    utxos = wallet.unspents.filter(function(unspent, minConf) {
      return unspent.confirmations >= minConf;
    });
  }
  utxos = utxos.sort(function(o1, o2) {
    return o2.value - o1.value;
  });

  var fees = [];

  for (var i = 0; i < wallet.feeRates.length; i++) {
    var maxAmount = wallet.maxAmounts[i];
    if (!unspents && maxAmount && value >= maxAmount.value) {
      fees.push(maxAmount.fee);
    } else {
      fees.push(estimate(wallet, wallet.feeRates[i].value, value, utxos));
    }
  }
  return fees;
}

function estimate(wallet, feeRate, value, utxos) {
  var network = bitcoin.networks[wallet.networkName];
  var to = wallet.getNextAddress(true);

  var builder = new bitcoin.TransactionBuilder(network);
  builder.addOutput(to, value);
  var csFee = addCsFee(wallet, builder, value);

  var txInfo = {
    ins: 0,
    outs: builder.tx.outs.length,
    outsLessDustSoftThreshold: 0
  };
  if (network.dustSoftThreshold !== undefined) {
    txInfo.outsLessDustSoftThreshold = builder.tx.outs.reduce(function (sum, e) {
      return (e.value < network.dustSoftThreshold) ? (sum + 1) : sum;
    }, 0);
  }
  var accum = 0;
  var estimatedFee = 0;
  utxos.some(function(unspent) {
    txInfo.ins++;
    estimatedFee = estimateFeePadChangeOutput(txInfo, feeRate * 1000) + csFee;
    accum += unspent.value;
    var subTotal = value + estimatedFee;

    if (accum >= subTotal) {
      return true;
    }
  });
  return estimatedFee;
}

function estimateFeePadChangeOutput(txInfo, feePerKb) {
  var baseFee = feePerKb / 1000;
  var byteSize = txInfo.ins * 148 + (txInfo.outs + 1) * 34 + 10;

  var fee = baseFee * byteSize;
  if (txInfo.outsLessDustSoftThreshold === 0) return fee;
  fee += (feePerKb * txInfo.outsLessDustSoftThreshold);
  return fee;
}

function getMaxAmounts(wallet) {
  var minConf = wallet.minConf;
  var balance = wallet.unspents.reduce(function(sum, unspent) {
    return unspent.confirmations >= minConf ? (sum + unspent.value) : sum;
  }, 0);
  var fees = estimateFees(wallet, balance);
  return fees.map(function(fee) {
    return {
      value: Math.max(balance - fee, 0),
      fee: fee,
      csFeeValue: balance
    };
  });
}

module.exports = {
  estimateFees: estimateFees,
  minimumFees: minimumFees,
  addCsFee: addCsFee,
  getMaxAmounts: getMaxAmounts
};
