'use strict';

var Addresses = require('./addresses');
var Transactions = require('./transactions');

function API(baseURL, network) {
  this.addresses = new Addresses(baseURL, network);
  this.transactions = new Transactions(baseURL);
}

module.exports = API;
