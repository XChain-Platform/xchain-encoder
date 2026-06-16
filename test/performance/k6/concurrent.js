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
 * k6 concurrency stress test for xchain-encoder JSON-RPC API.
 *
 * Ramps virtual users from 1 to 100 in a tight loop (no sleep)
 * to stress the Node.js event loop under heavy concurrent load.
 *
 * Requires a running API server:  npm run api
 * Run:  k6 run test/performance/k6/concurrent.js
 * Env:  ENCODER_URL (default http://localhost:3000)
 *       API_KEY     (default empty)
 */

import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = __ENV.ENCODER_URL || 'http://localhost:3000'
const API_KEY = __ENV.API_KEY || ''

export const options = {
  scenarios: {
    concurrent: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '60s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '60s', target: 100 },
        { duration: '30s', target: 0 }
      ]
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01']
  }
}

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

const HEADERS = { 'Content-Type': 'application/json' }
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
