/**
 * UTXO fixture factory for integration tests.
 *
 * Generates deterministic UTXO objects and raw transaction hex for mocking
 * BlockchainConnector and UtxoTracker without a live bitcoind.
 */

const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../../src/CryptoNetworks')

// Canonical test pubkey (secp256k1 generator point)
const PUBKEY_BUF = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)

// Deterministic TXIDs for reproducible tests
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
const TXID_C = 'c'.repeat(64)
// TXID that produces valid EC curve points for MULTISIGN tests
const TXID_MULTISIGN = '4e3472b63a459d2188711abcff6aa2548948f90c527aa60ec4a1101136879fe8'

/**
 * Build a minimal valid raw transaction hex for nonWitnessUtxo mocking.
 */
function buildRawTxHex (value, networkName) {
  const network = networkName
    ? CryptoNetworks.getBitcoinJsNetwork(networkName)
    : bitcoin.networks.regtest

  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 0x11), 0)
  const p2pkhScript = bitcoin.payments.p2pkh({
    pubkey: PUBKEY_BUF,
    network
  }).output
  tx.addOutput(p2pkhScript, value)
  return tx.toHex()
}

/**
 * Create a SegWit (P2WPKH) UTXO fixture.
 */
function makeSegwitUtxo (txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: PUBKEY_BUF,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2wpkh.output.toString('hex')
  }
}

/**
 * Create a legacy (P2PKH) UTXO fixture.
 */
function makeLegacyUtxo (txid, vout, value) {
  const p2pkh = bitcoin.payments.p2pkh({
    pubkey: PUBKEY_BUF,
    network: bitcoin.networks.regtest
  })
  return {
    txid,
    vout,
    value,
    confirmations: 6,
    scriptPubKey: p2pkh.output.toString('hex')
  }
}

/**
 * Create a mempool (unconfirmed) SegWit UTXO fixture.
 */
function makeMempoolUtxo (txid, vout, value) {
  const utxo = makeSegwitUtxo(txid, vout, value)
  utxo.confirmations = 0
  return utxo
}

/**
 * Get a test P2PKH address for a given network.
 */
function getTestAddress (networkName) {
  const network = CryptoNetworks.getBitcoinJsNetwork(networkName)
  return bitcoin.payments.p2pkh({ pubkey: PUBKEY_BUF, network }).address
}

/**
 * Create a standard mocked encoder with BlockchainConnector and UtxoTracker stubs.
 */
const XChainEncoder = require('../../../src/XChainEncoder')

function makeEncoder (networkName = 'dogecoin-regtest') {
  const encoder = new XChainEncoder(
    networkName, '127.0.0.1', '8333', 'rpc', 'rpc', '', ''
  )
  const rawTxHex = buildRawTxHex(100000000, networkName)
  encoder.connector = {
    getFeePerKilobyte: async () => 0.00001,
    getTransactionHex: async () => rawTxHex,
    isRegtest: async () => true
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => ({
      utxos: [makeSegwitUtxo(TXID_A, 0, 100000000)]
    })
  }
  return encoder
}

module.exports = {
  PUBKEY_BUF,
  TXID_A,
  TXID_B,
  TXID_C,
  TXID_MULTISIGN,
  buildRawTxHex,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeMempoolUtxo,
  getTestAddress,
  makeEncoder
}
