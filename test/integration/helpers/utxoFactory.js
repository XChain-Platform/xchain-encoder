/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * UTXO fixture factory for integration tests.
 *
 * Generates deterministic UTXO objects and raw transaction hex for mocking
 * BlockchainConnector and UtxoTracker without a live bitcoind.
 */

const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../../src/build/crypto_networks')

// Canonical test pubkey (secp256k1 generator point)
const PUBKEY_BUF = Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)

// The producer contract these fixtures model, pinned byte-for-byte by
// test/conformance/utxo_record_conformance.test.js. Read it rather than
// hand-copying the numbers, so the doubles and the conformance tier cannot
// describe two different producers (the drift that suite's header names).
const CONFORMANCE = require('../../fixtures/utxo-record-conformance.json')

// Height the confirmed factories report. Arbitrary but fixed, so a record's
// height and confirmations stay self-consistent across tests.
const CONFIRMED_HEIGHT = 100

// The tracker emits `value` as an exact decimal SATOSHI string because a DOGE
// consolidation output can exceed 2^53-1 (its LevelUpDb reads the field as a
// BigInt and stringifies it). Callers here still pass Numbers, so accept
// Number, string or BigInt and normalize to the producer's shape.
function toSatoshiString (value) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  return BigInt(Math.trunc(Number(value))).toString()
}

// `amount` is the same quantity as an 8-dp decimal COIN string, exactly as the
// tracker derives it (satoshiToDecimalString).
function toCoinAmount (satoshiString) {
  const negative = satoshiString.startsWith('-')
  const digits = (negative ? satoshiString.slice(1) : satoshiString).padStart(9, '0')
  return (negative ? '-' : '') + digits.slice(0, -8) + '.' + digits.slice(-8)
}

/**
 * Wrap records in the tracker's RESPONSE envelope, which carries the `sync`
 * freshness sibling beside `utxos`. Without it XChainEncoder's freshness gate
 * (`const sync = fetched && fetched.sync`) takes its fail-open branch, so a
 * hand-rolled `{ utxos }` stub silently skips that gate. `overrides` shallow-
 * merges into the healthy default so a test can make the view stale, halted or
 * not-yet-mempool-ready.
 */
function makeTrackerEnvelope (utxos, overrides) {
  return {
    utxos: utxos || [],
    sync: Object.assign({}, CONFORMANCE.sync, overrides || {})
  }
}

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

// Value the padding outputs below a fixture's vout carry. Never read by input
// selection; it only keeps outs[vout] at the index the UTXO names.
const FILLER_VALUE = 546

/**
 * Build one previous transaction per txid whose outs[vout] pays exactly what
 * each listed UTXO states, so input selection's prev-out value check agrees.
 * Returns a Map of txid to raw hex; lower vouts are padded with filler outputs
 * and several vouts of one txid share a transaction.
 */
function buildPrevTxHexByTxid (utxos, networkName) {
  const network = networkName
    ? CryptoNetworks.getBitcoinJsNetwork(networkName)
    : bitcoin.networks.regtest
  const script = bitcoin.payments.p2pkh({ pubkey: PUBKEY_BUF, network }).output
  const valuesByTxid = new Map()
  for (const utxo of utxos) {
    const values = valuesByTxid.get(utxo.txid) || new Map()
    const stated = BigInt(toSatoshiString(utxo.value))
    if (values.has(utxo.vout) && values.get(utxo.vout) !== stated) {
      throw new Error(`fixture lists ${utxo.txid}:${utxo.vout} twice with different values`)
    }
    values.set(utxo.vout, stated)
    valuesByTxid.set(utxo.txid, values)
  }
  const hexByTxid = new Map()
  let seed = 0
  for (const [txid, values] of valuesByTxid) {
    const tx = new bitcoin.Transaction()
    // Vary the spent outpoint so each fixture txid decodes to a distinct tx.
    tx.addInput(Buffer.alloc(32, 0x11), seed++)
    const lastVout = Math.max(...values.keys())
    for (let vout = 0; vout <= lastVout; vout++) {
      const big = values.has(vout) ? values.get(vout) : BigInt(FILLER_VALUE)
      // The bufferutils patch writes a BigInt only above 2^53-1; keep Numbers below it.
      tx.addOutput(script, big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big)
    }
    hexByTxid.set(txid, tx.toHex())
  }
  return hexByTxid
}

/**
 * Point encoder.connector.getTransactionHex at per-txid previous transactions
 * built from `utxos`, and return the lookup map. An unlisted txid rejects, so a
 * fixture that forgets a UTXO fails loudly instead of reading a stranger's tx.
 */
function attachPrevTxs (encoder, utxos, networkName) {
  const hexByTxid = buildPrevTxHexByTxid(utxos, networkName)
  encoder.connector.getTransactionHex = async (txid) => {
    if (!hexByTxid.has(txid)) throw new Error(`no previous-tx fixture for txid ${txid}`)
    return hexByTxid.get(txid)
  }
  return hexByTxid
}

/**
 * Create a SegWit (P2WPKH) UTXO fixture.
 */
function makeSegwitUtxo (txid, vout, value) {
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: PUBKEY_BUF,
    network: bitcoin.networks.regtest
  })
  const sats = toSatoshiString(value)
  return {
    txid,
    vout,
    value: sats,
    amount: toCoinAmount(sats),
    height: CONFIRMED_HEIGHT,
    coinbase: false,
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
  const sats = toSatoshiString(value)
  return {
    txid,
    vout,
    value: sats,
    amount: toCoinAmount(sats),
    height: CONFIRMED_HEIGHT,
    coinbase: false,
    confirmations: 6,
    scriptPubKey: p2pkh.output.toString('hex')
  }
}

/**
 * Create the UTXO fixture the named chain can actually hold. A witness-program
 * output only exists where consensus knows segwit, and input selection refuses
 * one where it does not, so a suite that names its chain gets a matching input.
 */
function makeUtxo (networkName, txid, vout, value) {
  const network = CryptoNetworks.getBitcoinJsNetwork(networkName)
  return network.supportsSegwit === false
    ? makeLegacyUtxo(txid, vout, value)
    : makeSegwitUtxo(txid, vout, value)
}

/**
 * Create a mempool (unconfirmed) SegWit UTXO fixture.
 */
function makeMempoolUtxo (txid, vout, value) {
  const utxo = makeSegwitUtxo(txid, vout, value)
  utxo.confirmations = 0
  // The tracker sends height null for an unconfirmed output; a fixed confirmed
  // height beside confirmations 0 would be a record it never serves.
  utxo.height = null
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
    getNetworkInfo: async () => ({ relayfee: 0.00001 }),
    getTransactionHex: async () => rawTxHex,
    isRegtest: async () => true,
    assertNodeTier: async () => {}
  }
  encoder.utxoTrackerConnector = {
    getUtxosFromAddress: async () => makeTrackerEnvelope([makeUtxo(networkName, TXID_A, 0, 100000000)])
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
  buildPrevTxHexByTxid,
  attachPrevTxs,
  makeSegwitUtxo,
  makeLegacyUtxo,
  makeUtxo,
  makeMempoolUtxo,
  makeTrackerEnvelope,
  getTestAddress,
  makeEncoder
}
