'use strict';

const Addresses = require('./addresses');
const Transactions = require('./transactions');

function API(baseURL, network) {
  this.addresses = new Addresses(baseURL, network);
  this.transactions = new Transactions(baseURL);
}

module.exports = API;
