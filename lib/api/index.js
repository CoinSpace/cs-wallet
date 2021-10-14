'use strict';

const Addresses = require('./addresses');
const Transactions = require('./transactions');
const { setRequest } = require('./utils');

class API {
  constructor(request, baseURL, network) {
    setRequest(request);
    this.addresses = new Addresses(baseURL, network);
    this.transactions = new Transactions(baseURL);
  }
}

module.exports = API;
