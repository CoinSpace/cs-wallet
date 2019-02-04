'use strict';

var Addresses = require('./addresses');
var Transactions = require('./transactions');

function API(baseURL) {
  // eslint-disable-next-line no-undef
  this.addresses = new Addresses(baseURL);
  this.transactions = new Transactions(baseURL);
}

module.exports = API;
