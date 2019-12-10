'use strict';
var axios = require('axios');
var pathToRegexp = require('path-to-regexp');
var _ = require('lodash');

function postRequest(url, item) {
  return axios.post(url, item)
    .then(function(res) {
      return res.data;
    }).catch(function(err) {
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
  var delayBeforeRetry = options.delayBeforeRetry !== undefined ? options.delayBeforeRetry : 1000;
  return request(url, options.retry || 100, delayBeforeRetry, options.params || {})
    .then(function(res) {
      return res.data;
    });
}

function request(url, retry, delayBeforeRetry, params) {
  return axios.get(url, {params: params})
    .catch(function(err) {
      if (err.code === 'ECONNRESET' && --retry > 0) {
        return delay(delayBeforeRetry)
          .then(function() {
            return request(url, retry);
          });
      }
      console.error(err);
      throw new Error('cs-node-error');
    });
}

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  getRequest: getRequest,
  postRequest: postRequest,
  batchGetRequest: batchGetRequest
};
