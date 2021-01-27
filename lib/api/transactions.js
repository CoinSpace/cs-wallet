'use strict';

const { postRequest, batchGetRequest } = require('./utils');

class Transactions {
  constructor(url) {
    this.url = url;
  }
  /**
   * request information about transaction(s) by id(s)
   *
   * @param txIds
   * @param params
   * @returns {axios.Promise}
   */
  get(txIds, params) {
    return batchGetRequest(this.url, 'txs/', txIds, {
      params,
    }).then((txs) => {
      const results = txs.map((tx) => {
        return {
          txId: tx.txid,
          fees: tx.fees,
          timestamp: tx.time,
          confirmations: tx.confirmations,
          vin: tx.vin,
          vout: tx.vout,
          version: tx.version,
        };
      });
      return results;
    });
  }
  /**
   * request sort tx ids by confirmations
   *
   * @param txIds
   * @returns {axios.Promise}
   */
  getSortedTxIds(txIds) {
    const params = txIds.map((id) => { return { id }; });
    return batchGetRequest(this.url, 'txs/:id/confirmations', params).then((results) => {
      return results.sort((a, b) => {
        if (a.confirmations === 0 && b.confirmations === 0) {
          return b.time - a.time;
        }
        return a.confirmations - b.confirmations;
      }).map((tx) => {
        return tx.txid;
      });
    });
  }
  /**
   * post some transactions
   *
   * @param transaction
   * @returns {axios.Promise}
   */
  propagate(hex) {
    return postRequest(this.url + 'tx/send', { rawtx: hex });
  }
}

module.exports = Transactions;
