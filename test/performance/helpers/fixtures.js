'use strict'

const {
  TXID_A, TXID_B, TXID_C, TXID_MULTISIGN, PUBKEY_BUF,
  makeSegwitUtxo, makeLegacyUtxo, makeEncoder, getTestAddress, buildRawTxHex
} = require('../../integration/helpers/utxoFactory')

const {
  makeSend, makeIssueFull, makeFileLarge, makeActionOfSize,
  makeBatch, makeMint, makeDestroy
} = require('../../integration/helpers/actionFactory')

// Pre-compute addresses once
const DOGE_REGTEST_ADDR = getTestAddress('dogecoin-regtest')
const BTC_REGTEST_ADDR = getTestAddress('bitcoin-regtest')
const COMPRESSED_PUBKEY = PUBKEY_BUF.toString('hex')

// Helper: build a scenario object with sane defaults
function scenario (id, label, overrides) {
  return Object.assign({
    id,
    label,
    network: 'dogecoin-regtest',
    encoding: null,
    rawData: null,
    fee: null,
    feePerKb: 0.00001,
    change: DOGE_REGTEST_ADDR,
    compressedPubKey: null,
    p2shHash: null,
    p2shHex: null,
    customOutputs: null,
    rbf: false,
    unconfirmed: true,
    dust: null,
    pubkey: DOGE_REGTEST_ADDR,
    makeUtxos: () => [makeSegwitUtxo(TXID_A, 0, 100000000)]
  }, overrides)
}

// ── Baseline Scenarios ──────────────────────────────────────────

const send = makeSend()
const issueFull = makeIssueFull()
const fileLarge = makeFileLarge()

const BASE = [
  scenario('BASE-01', 'OP_RETURN auto (SEND)', {
    data: send.data
  }),
  scenario('BASE-02', 'OP_RETURN forced (SEND)', {
    data: send.data,
    encoding: 'OP_RETURN'
  }),
  scenario('BASE-03', 'P2SH auto (ISSUE full)', {
    data: issueFull.data
  }),
  scenario('BASE-04', 'P2SH forced max chunk', {
    data: makeActionOfSize(476).data,
    encoding: 'P2SH'
  }),
  scenario('BASE-05', 'P2WSH medium (FILE)', {
    data: fileLarge.data,
    encoding: 'P2WSH',
    network: 'bitcoin-regtest',
    pubkey: BTC_REGTEST_ADDR,
    change: BTC_REGTEST_ADDR,
    makeUtxos: () => [makeSegwitUtxo(TXID_A, 0, 100000000)]
  }),
  scenario('BASE-06', 'P2WSH max chunk', {
    data: makeActionOfSize(3571).data,
    encoding: 'P2WSH',
    network: 'bitcoin-regtest',
    pubkey: BTC_REGTEST_ADDR,
    change: BTC_REGTEST_ADDR,
    makeUtxos: () => [makeSegwitUtxo(TXID_A, 0, 100000000)]
  }),
  scenario('BASE-07', 'MULTISIGN', {
    data: 'A'.repeat(59),
    encoding: 'MULTISIGN',
    compressedPubKey: COMPRESSED_PUBKEY,
    makeUtxos: () => [makeSegwitUtxo(TXID_MULTISIGN, 0, 100000000)]
  }),
  scenario('BASE-08', 'OP_RETURN legacy UTXO', {
    data: send.data,
    makeUtxos: () => [makeLegacyUtxo(TXID_A, 0, 100000000)]
  })
]

// ── Complex Scenarios ───────────────────────────────────────────

const CPLX = [
  scenario('CPLX-01', '10-UTXO aggregation', {
    data: send.data,
    makeUtxos: () => {
      const utxos = []
      for (let i = 0; i < 10; i++) {
        utxos.push(makeSegwitUtxo(TXID_A.slice(0, 62) + String(i).padStart(2, '0'), i, 10000))
      }
      return utxos
    }
  }),
  scenario('CPLX-02', '10-chunk OP_RETURN', {
    data: makeActionOfSize(760).data,
    encoding: 'OP_RETURN'
  }),
  scenario('CPLX-03', '3-chunk P2SH', {
    data: makeActionOfSize(1428).data,
    encoding: 'P2SH'
  }),
  scenario('CPLX-04', '2-chunk P2WSH', {
    data: makeActionOfSize(7142).data,
    encoding: 'P2WSH',
    network: 'bitcoin-regtest',
    pubkey: BTC_REGTEST_ADDR,
    change: BTC_REGTEST_ADDR,
    makeUtxos: () => [makeSegwitUtxo(TXID_A, 0, 100000000)]
  }),
  scenario('CPLX-05', 'Batch 4-action', {
    data: makeBatch([makeSend(), makeIssueFull(), makeMint(), makeDestroy()]).data
  }),
  scenario('CPLX-06', 'With rawData', {
    data: send.data,
    rawData: 'R'.repeat(40)
  })
]

// ── Scaling Matrices ────────────────────────────────────────────

const UTXO_COUNTS = [1, 5, 10, 25, 50].map(n =>
  scenario(`UTXO-${String(n).padStart(3, '0')}`, `${n} UTXOs`, {
    data: send.data,
    makeUtxos: () => {
      const utxos = []
      for (let i = 0; i < n; i++) {
        utxos.push(makeSegwitUtxo(TXID_A.slice(0, 62) + String(i).padStart(2, '0'), i, 10000))
      }
      return utxos
    }
  })
)

const PAYLOAD_SIZES = [10, 50, 76, 77, 200, 476, 1000, 3571].map(size =>
  scenario(`SIZE-${String(size).padStart(5, '0')}`, `${size}-byte payload`, {
    data: makeActionOfSize(size).data,
    // Payloads >76 bytes auto-select P2SH; >3571 would need P2WSH on bitcoin-regtest
    // but we cap at 3571 for dogecoin compatibility and use explicit P2SH for large ones
    encoding: size <= 76 ? null : 'P2SH'
  })
)

module.exports = {
  BASE,
  CPLX,
  UTXO_COUNTS,
  PAYLOAD_SIZES,
  makeEncoder,
  DOGE_REGTEST_ADDR,
  BTC_REGTEST_ADDR,
  COMPRESSED_PUBKEY
}
