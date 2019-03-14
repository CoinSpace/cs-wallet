'use strict';
module.exports = {
  mainnet: {
    bitcoin: {
      messagePrefix: '\x18Bitcoin Signed Message:\n',
      bech32: 'bc',
      bip32: {
        public: 0x0488b21e,
        private: 0x0488ade4
      },
      pubKeyHash: 0x00,
      scriptHash: 0x05,
      wif: 0x80,
      dustThreshold: 546,
      feePerKb: 10000
    },
    bitcoincash: {
      messagePrefix: '\x18Bitcoin Signed Message:\n',
      bech32: 'bc',
      bip32: {
        public: 0x0488b21e,
        private: 0x0488ade4
      },
      pubKeyHash: 0x00,
      scriptHash: 0x05,
      wif: 0x80,
      dustThreshold: 546,
      feePerKb: 10000
    },
    litecoin: {
      messagePrefix: '\x19Litecoin Signed Message:\n',
      bech32: 'ltc',
      bip32: {
        public: 0x019da462,
        private: 0x019d9cfe
      },
      pubKeyHash: 0x30,
      scriptHash: 0x32,
      wif: 0xb0,
      dustThreshold: 54600,
      dustSoftThreshold: 100000,
      feePerKb: 100000
    },
    dogecoin: {
      messagePrefix: '\x19Dogecoin Signed Message:\n',
      bip32: {
        public: 0x02facafd,
        private: 0x02fac398
      },
      pubKeyHash: 0x1e,
      scriptHash: 0x16,
      wif: 0x9e,
      dustThreshold: 1000000,
      dustSoftThreshold: 100000000,
      feePerKb: 100000000,
    },
  },
  regtest: {
    bitcoin: {
      bech32: 'bcrt',
      messagePrefix: '\x18Bitcoin Signed Message:\n',
      bip32: {
        public: 0x043587cf,
        private: 0x04358394
      },
      pubKeyHash: 0x6f,
      scriptHash: 0xc4,
      wif: 0xef,
      dustThreshold: 546,
      feePerKb: 10000,
    },
    bitcoincash: {
      bech32: 'bcrt',
      messagePrefix: '\x18Bitcoin Signed Message:\n',
      bip32: {
        public: 0x043587cf,
        private: 0x04358394
      },
      pubKeyHash: 0x6f,
      scriptHash: 0xc4,
      wif: 0xef,
      dustThreshold: 546,
      feePerKb: 10000,
    },
    litecoin: {
      messagePrefix: '\x19Litecoin Signed Message:\n',
      bech32: 'rltc',
      bip32: {
        public: 0x043587cf,
        private: 0x04358394
      },
      pubKeyHash: 0x6f,
      scriptHash: 0xc4,
      wif: 0xef,
      dustThreshold: 54600,
      dustSoftThreshold: 100000,
      feePerKb: 100000
    },
    dogecoin: {
      messagePrefix: '\x19Dogecoin Signed Message:\n',
      bip32: {
        public: 0x043587cf,
        private: 0x04358394
      },
      pubKeyHash: 0x71,
      scriptHash: 0xc4,
      wif: 0xf1,
      dustThreshold: 1000000,
      dustSoftThreshold: 100000000,
      feePerKb: 100000000,
    },
  }
};
