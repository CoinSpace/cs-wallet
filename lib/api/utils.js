'use strict';

var axios = require('axios').create({timeout: 30000});
var axiosRetry = require('axios-retry');
var pathToRegexp = require('path-to-regexp');
var _ = require('lodash');

axiosRetry(axios, {retries: 3, retryDelay: axiosRetry.exponentialDelay, shouldResetTimeout: true});

function postRequest(url, item) {
  return axios.post(url, item)
    .then(function(res) {
      return res.data;
    }).catch(function(err) {
      if (err.response && err.response.data === 'txn-mempool-conflict') throw new Error('cs-node-error');
      console.error(err);
      throw new Error('cs-node-error');
    });
}

function batchGetRequest(url, path, items, options) {
  options = options || {};

  items = items !== undefined ? [].concat(items) : [];

  // filter empty items
  items = items.filter(function(item) {
    return !!item;
  });

  // group items by chunks
  var maxChunk = options.maxChunk || 50;
  var isString = !Array.isArray(items) || typeof items[0] !== 'object';

  if (isString) {
    items = _.chunk(items, maxChunk).map(function(items) {
      return items.join(',');
    });
  } else {
    items = _.chunk(items, maxChunk).map(function(items) {
      return items.reduce(function(sum, item) {
        Object.keys(item).forEach(function(key) {
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

  return items.reduce(function(promise, item) {
    return promise.then(function(result) {
      var tokens = pathToRegexp.parse(path);
      var queryUrl;
      if (tokens.length > 1) {
        queryUrl = url + pathToRegexp.tokensToFunction(tokens)(item);
      } else {
        queryUrl = url + path + encodeURIComponent(item);
      }
      return getRequest(queryUrl, options).then(Array.prototype.concat.bind(result));
    });
  }, Promise.resolve([])).then(function(res) {
    return res;
  });
}

function getRequest(url, options) {
  options = options || {};
  return request(url, options.params || {})
    .then(function(res) {
      return res.data;
    });
}

function request(url, params) {
  return axios.get(url, {params: params})
    .catch(function(err) {
      console.error(err);
      throw new Error('cs-node-error');
    });
}

module.exports = {
  getRequest: getRequest,
  postRequest: postRequest,
  batchGetRequest: batchGetRequest
};
