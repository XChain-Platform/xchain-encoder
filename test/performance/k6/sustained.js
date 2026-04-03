/**
 * k6 sustained load test for xchain-encoder JSON-RPC API.
 *
 * Requires a running API server:  npm run api
 * Run:  k6 run test/performance/k6/sustained.js
 * Env:  ENCODER_URL (default http://localhost:3000)
 *       API_KEY     (default empty)
 */

import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = __ENV.ENCODER_URL || 'http://localhost:3000'
const API_KEY = __ENV.API_KEY || ''

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 20,
      maxVUs: 50
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01']
  }
}

// Pre-built JSON-RPC payload: OP_RETURN SEND on dogecoin-regtest
const PAYLOAD = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'create_tx',
  params: {
    utxos: [{
      txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      vout: 0,
      value: 100000000,
      confirmations: 6,
      scriptPubKey: '0014751e76e8199196d454941c45d1b3a323f1433bd6'
    }],
    pubkey: 'nesRpRaAbTDmZHwmzBkLd2AtF7Z9L9z5S2',
    customOutputs: null,
    data: 'SEND|0|JDOG|1|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev',
    rawData: null,
    fee: null,
    rbf: false,
    encoding: null,
    change: 'nesRpRaAbTDmZHwmzBkLd2AtF7Z9L9z5S2',
    p2shHash: null,
    p2shHex: null,
    compressedPubKey: null,
    unconfirmed: true,
    feePerKb: 0.00001,
    dust: null
  }
})

const HEADERS = {
  'Content-Type': 'application/json'
}
if (API_KEY) HEADERS['x-api-key'] = API_KEY

export default function () {
  const res = http.post(BASE_URL, PAYLOAD, { headers: HEADERS })
  check(res, {
    'status 200': r => r.status === 200,
    'no rpc error': r => {
      try { return !JSON.parse(r.body).error } catch (_) { return false }
    }
  })
}
