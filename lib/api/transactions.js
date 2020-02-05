'use strict';

var batchGetRequest = require('./utils').batchGetRequest;
var postRequest = require('./utils').postRequest;

function Transactions(url) {
  this.url = url;
}

/**
 * request information about transaction(s) by id(s)
 *
 * @param txIds
 * @param params
 * @returns {axios.Promise}
 */
Transactions.prototype.get = function(txIds, params) {
  return batchGetRequest(this.url, 'txs/', txIds, {
    params: params
  }).then(function(txs) {
    var results = txs.map(function(tx) {
      return {
        txId: tx.txid,
        fees: tx.fees,
        timestamp: tx.time,
        confirmations: tx.confirmations,
        vin: tx.vin,
        vout: tx.vout,
        version: tx.version
      };
    });
    return results;
  });
};

/**
 * request serted tx ids
 *
 * @param txIds
 * @returns {axios.Promise}
 */
Transactions.prototype.getSortedTxIds = function(txIds) {
  var params = txIds.map(function(id) { return {id: id}; });
  return batchGetRequest(this.url, 'txs/:id/sorted', params);
};

/**
 * post some transactions
 *
 * @param transaction
 * @returns {axios.Promise}
 */
Transactions.prototype.propagate = function(hex) {
  return postRequest(this.url + 'tx/send', {rawtx: hex});
};

module.exports = Transactions;
