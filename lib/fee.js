'use strict';
const validate = require('./validator');
const bitcoin = require('./bitcoin');

function minimumFees(wallet, value) {
  if (typeof value !== 'number') value = parseInt(value);
  const fees = [];
  for (let i = 0; i < wallet.feeRates.length; i++) {
    const csFee = getCsFee(wallet, value);
    const fee = wallet.feeRates[i].value * 226;
    fees.push(fee + csFee);
  }
  return fees;
}

function addCsFee(wallet, builder, value) {
  const fee = getCsFee(wallet, value);
  if (fee > 0) {
    builder.addOutput(wallet.csFeeAddresses[0], fee);
  }
  return fee;
}

function getCsFee(wallet, value) {
  if (wallet.csFeeOff) return 0;
  if (!wallet.csFee || !wallet.csMaxFee) return 0;
  if (wallet.csFeeAddresses.length === 0) return 0;

  const { network } = wallet;
  let fee = Math.floor(value * wallet.csFee);
  if (wallet.csSkipMinFee === true && fee < wallet.csMinFee) {
    return 0;
  }
  fee = Math.max(wallet.csMinFee, fee);
  fee = Math.min(wallet.csMaxFee, fee);

  if (wallet.csMinFee) {
    let exportTxFee = 192 * network.feePerByte;
    if (network.dustSoftThreshold && fee < network.dustSoftThreshold) {
      exportTxFee += (1000 * network.feePerByte);
    }
    fee += exportTxFee;
  }
  if (fee < network.dustThreshold) return 0;
  return fee;
}

function estimateFees(wallet, value, unspents) {
  if (typeof value !== 'number') value = parseInt(value);

  let utxos;
  if (unspents != null) {
    validate.utxos(unspents);
    utxos = wallet.getUnspentsForTx({ unspents });
  } else {
    utxos = wallet.getUnspentsForTx();
  }

  const fees = [];
  const minimum = minimumFees(wallet, value);

  for (let i = 0; i < wallet.feeRates.length; i++) {
    const feeRate = wallet.feeRates[i];
    const maxAmount = wallet.maxAmounts[i];
    if (!unspents && maxAmount && value >= maxAmount.value) {
      fees.push({
        name: feeRate.name,
        estimate: maxAmount.fee,
        default: feeRate.default === true,
        maxAmount: maxAmount.value,
      });
    } else {
      const estimatedFee = estimate(wallet, feeRate.value, value, utxos);
      if (estimatedFee) {
        fees.push({
          name: feeRate.name,
          estimate: estimatedFee,
          default: feeRate.default === true,
          maxAmount: maxAmount && maxAmount.value,
        });
      } else {
        fees.push({
          name: feeRate.name,
          estimate: minimum[i],
          default: feeRate.default === true,
          maxAmount: maxAmount && maxAmount.value,
        });
      }
    }
  }
  return fees;
}

function estimate(wallet, feeRate, value, utxos) {
  const { network } = wallet;
  const txInfo = {
    ins: {},
    outs: {},
    outsLessDustSoftThreshold: 0,
  };

  const to = wallet.getNextAddress({ oldFormat: true });
  const builder = new bitcoin.TransactionBuilder(network);
  builder.addOutput(to, value);
  txInfo.outs.p2wsh = 1; // suppose it's the largest

  const csFee = addCsFee(wallet, builder, value);
  if (builder.tx.outs.length == 2) {
    const csFeeAddressType = bitcoin.address.getAddressType(wallet.csFeeAddresses[0], wallet.network);
    txInfo.outs[csFeeAddressType] = (txInfo.outs[csFeeAddressType] || 0) + 1;
  }

  if (network.dustSoftThreshold !== undefined) {
    txInfo.outsLessDustSoftThreshold = builder.tx.outs.reduce((sum, e) => {
      return (e.value < network.dustSoftThreshold) ? (sum + 1) : sum;
    }, 0);
  }
  let accum = 0;
  let estimatedFee = 0;
  utxos.some((unspent) => {
    txInfo.ins[unspent.type] = (txInfo.ins[unspent.type] || 0) + 1;
    estimatedFee = estimateFeePadChangeOutput(txInfo, feeRate, wallet.addressType) + csFee;
    accum += unspent.value;
    const subTotal = value + estimatedFee;

    if (accum >= subTotal) {
      return true;
    }
  });
  return estimatedFee;
}

function estimateFeePadChangeOutput(txInfo, feePerByte, addressType) {
  const old = txInfo.outs[addressType];
  txInfo.outs[addressType] = (txInfo.outs[addressType] || 0) + 1;
  const vBytes = bitcoin.TransactionBuilder.getVBytes(txInfo);
  txInfo.outs[addressType] = old;

  let fee = feePerByte * vBytes;
  if (txInfo.outsLessDustSoftThreshold === 0) return fee;
  fee += ((1000 * feePerByte) * txInfo.outsLessDustSoftThreshold);
  return fee;
}

function setMaxAmounts(wallet) {
  wallet.maxAmounts = [];
  const balance = wallet.getUnspentsForTx().reduce((sum, unspent) => {
    return sum + unspent.value;
  }, 0);
  const fees = estimateFees(wallet, balance);
  wallet.maxAmounts = fees.map((fee) => {
    return {
      value: Math.max(balance - fee.estimate, 0),
      fee: fee.estimate,
      csFeeValue: balance,
    };
  });
}

module.exports = {
  estimateFees,
  minimumFees,
  addCsFee,
  setMaxAmounts,
};
