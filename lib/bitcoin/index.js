'use strict';

var bitcoin = require('bitcoinjs-lib');
var networks = require('./networks');

// eslint-disable-next-line no-undef
bitcoin.networks = networks[process.env.COIN_NETWORK || 'mainnet'];

module.exports = bitcoin;
