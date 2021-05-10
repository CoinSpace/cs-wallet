'use strict';

const axios = require('axios').create({ timeout: 30000 });
const axiosRetry = require('axios-retry');
const pathToRegexp = require('path-to-regexp');

function chunk(array, size) {
  const result = [];
  let index = 0;
  while (index < array.length) {
    result.push(array.slice(index, (index += size)));
  }
  return result;
}

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay, shouldResetTimeout: true });

function postRequest(url, item) {
  return axios.post(url, item)
    .then((res) => {
      return res.data;
    }).catch((err) => {
      if (err.response && err.response.data === 'txn-mempool-conflict') throw new Error('cs-node-error');
      console.error(err);
      throw new Error('cs-node-error');
    });
}

function batchGetRequest(url, path, items, options) {
  options = options || {};

  items = items !== undefined ? [].concat(items) : [];

  // filter empty items
  items = items.filter((item) => {
    return !!item;
  });

  // group items by chunks
  const maxChunk = options.maxChunk || 50;
  const isString = !Array.isArray(items) || typeof items[0] !== 'object';

  if (isString) {
    items = chunk(items, maxChunk).map((items) => {
      return items.join(',');
    });
  } else {
    items = chunk(items, maxChunk).map((items) => {
      return items.reduce((sum, item) => {
        Object.keys(item).forEach((key) => {
          if (sum[key]) {
            sum[key] += ',' + item[key];
          } else {
            sum[key] = '' + item[key];
          }
        });
        return sum;
      }, {});
    });
  }

  return items.reduce((promise, item) => {
    return promise.then((result) => {
      const tokens = pathToRegexp.parse(path);
      let queryUrl;
      if (tokens.length > 1) {
        queryUrl = url + pathToRegexp.tokensToFunction(tokens)(item);
      } else {
        queryUrl = url + path + encodeURIComponent(item);
      }
      return getRequest(queryUrl, options).then(Array.prototype.concat.bind(result));
    });
  }, Promise.resolve([])).then((res) => {
    return res;
  });
}

function getRequest(url, options) {
  options = options || {};
  return request(url, options.params || {})
    .then((res) => {
      return res.data;
    });
}

function request(url, params) {
  return axios.get(url, { params })
    .catch((err) => {
      console.error(err);
      throw new Error('cs-node-error');
    });
}

module.exports = {
  getRequest,
  postRequest,
  batchGetRequest,
};
