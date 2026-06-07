/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Security: input validation
 *
 * The encoder is handed untrusted request parameters (UTXOs, addresses,
 * ACTION data, fees, encodings). src/validator.js is the gate that must
 * reject hostile input with a typed error — or coerce it to a safe
 * primitive — before any of it reaches bitcoinjs-lib or the PSBT builder.
 * These tests attack that gate: malformed types, injection-shaped strings,
 * over-limit sizes, and degenerate numbers. The invariant throughout is
 * "rejected with TypeError/RangeError, OR returned as a clean primitive —
 * never the raw attacker string passed through".
 */

const assert = require('assert')
const V = require('../../src/validator')

const HEX64 = 'a'.repeat(64)
const SQLI = "1'; DROP TABLE blocks;--"
const XSS = '<script>alert(1)</script>'

describe('Security: validateUtxoArray / validateUtxoEntry', () => {
    it('rejects a non-array utxos', () => {
        assert.throws(() => V.validateUtxoArray('not-an-array'), TypeError)
        assert.throws(() => V.validateUtxoArray({ 0: {} }), TypeError)
    })

    it('rejects an over-limit UTXO set (DoS via huge input)', () => {
        const huge = Array.from({ length: V.MAX_UTXO_COUNT + 1 }, () => ({
            txid: HEX64, vout: 0, value: 1000, scriptPubKey: '00'
        }))
        assert.throws(() => V.validateUtxoArray(huge), RangeError)
    })

    it('accepts exactly MAX_UTXO_COUNT (off-by-one upper edge)', () => {
        const max = Array.from({ length: V.MAX_UTXO_COUNT }, () => ({
            txid: HEX64, vout: 0, value: 1000, scriptPubKey: '00'
        }))
        assert.doesNotThrow(() => V.validateUtxoArray(max))
    })

    it('rejects a txid that is not 64 hex chars (injection-shaped)', () => {
        assert.throws(() => V.validateUtxoEntry({ txid: SQLI, vout: 0, value: 1, scriptPubKey: '00' }, 0), TypeError)
        assert.throws(() => V.validateUtxoEntry({ txid: 'g'.repeat(64), vout: 0, value: 1, scriptPubKey: '00' }, 0), TypeError)
        assert.throws(() => V.validateUtxoEntry({ txid: HEX64 + 'a', vout: 0, value: 1, scriptPubKey: '00' }, 0), TypeError)
    })

    it('rejects negative / non-integer vout and value', () => {
        assert.throws(() => V.validateUtxoEntry({ txid: HEX64, vout: -1, value: 1, scriptPubKey: '00' }, 0), TypeError)
        assert.throws(() => V.validateUtxoEntry({ txid: HEX64, vout: 1.5, value: 1, scriptPubKey: '00' }, 0), TypeError)
        assert.throws(() => V.validateUtxoEntry({ txid: HEX64, vout: 0, value: -100, scriptPubKey: '00' }, 0), RangeError)
    })

    it('coerces a numeric-prefixed injection value to a clean integer (never passes the raw string)', () => {
        const entry = { txid: HEX64, vout: 0, value: '1000; DROP TABLE', scriptPubKey: '00' }
        V.validateUtxoEntry(entry, 0)
        assert.strictEqual(entry.value, 1000)
        assert.strictEqual(typeof entry.value, 'number')
    })

    it('rejects an empty/missing scriptPubKey', () => {
        assert.throws(() => V.validateUtxoEntry({ txid: HEX64, vout: 0, value: 1, scriptPubKey: '' }, 0), TypeError)
        assert.throws(() => V.validateUtxoEntry({ txid: HEX64, vout: 0, value: 1 }, 0), TypeError)
    })

    it('rejects array/null entries masquerading as objects (prototype confusion)', () => {
        assert.throws(() => V.validateUtxoEntry([], 0), TypeError)
        assert.throws(() => V.validateUtxoEntry(null, 0), TypeError)
    })
})

describe('Security: validatePubkey / validateChange / validateCompressedPubKey', () => {
    it('rejects non-string and empty pubkey', () => {
        assert.throws(() => V.validatePubkey(123), TypeError)
        assert.throws(() => V.validatePubkey(''), TypeError)
    })

    it('rejects an over-length pubkey (memory/abuse guard at 200)', () => {
        assert.throws(() => V.validatePubkey('a'.repeat(201)), TypeError)
        assert.doesNotThrow(() => V.validatePubkey('a'.repeat(200)))
    })

    it('passes null through (optional param) without throwing', () => {
        assert.strictEqual(V.validatePubkey(null), null)
        assert.strictEqual(V.validateChange(null), null)
        assert.strictEqual(V.validateCompressedPubKey(null), null)
    })

    it('rejects an over-length / injection-shaped change address', () => {
        assert.throws(() => V.validateChange(XSS + 'a'.repeat(100)), TypeError)
        assert.throws(() => V.validateChange(''), TypeError)
    })

    it('rejects a compressedPubKey that is not 02/03 + 64 hex', () => {
        assert.throws(() => V.validateCompressedPubKey('04' + 'a'.repeat(64)), TypeError)
        assert.throws(() => V.validateCompressedPubKey('02' + 'z'.repeat(64)), TypeError)
        assert.throws(() => V.validateCompressedPubKey(SQLI), TypeError)
        assert.doesNotThrow(() => V.validateCompressedPubKey('02' + 'a'.repeat(64)))
    })
})

describe('Security: validateCombinedDataLength (payload-size DoS guard)', () => {
    it('accepts a payload at exactly the limit', () => {
        assert.doesNotThrow(() => V.validateCombinedDataLength('a'.repeat(V.MAX_DATA_BYTES), null))
    })

    it('rejects a payload one byte over the limit', () => {
        assert.throws(() => V.validateCombinedDataLength('a'.repeat(V.MAX_DATA_BYTES + 1), null), RangeError)
    })

    it('counts multi-byte UTF-8 by bytes, not characters (no smuggling past the cap)', () => {
        // '€' is 3 UTF-8 bytes; a string of N euro signs is 3N bytes.
        const n = Math.floor(V.MAX_DATA_BYTES / 3) + 1
        assert.throws(() => V.validateCombinedDataLength('€'.repeat(n), null), RangeError)
    })

    it('includes rawData (Latin-1 bytes) in the combined total', () => {
        const data = 'a'.repeat(V.MAX_DATA_BYTES - 10)
        assert.throws(() => V.validateCombinedDataLength(data, 'b'.repeat(20)), RangeError)
    })
})

describe('Security: validateFee / validateFeePerKb / validateDust', () => {
    it('rejects negative and over-max fee', () => {
        assert.throws(() => V.validateFee(-1), RangeError)
        assert.throws(() => V.validateFee(V.MAX_FEE_SATOSHIS + 1), RangeError)
    })

    it('coerces a numeric-prefixed fee string to a safe integer (no raw passthrough)', () => {
        assert.strictEqual(V.validateFee('500; rm -rf'), 500)
    })

    it('rejects a fully non-numeric fee', () => {
        assert.throws(() => V.validateFee('not-a-number'), TypeError)
    })

    it('rejects non-finite and non-positive feePerKb', () => {
        assert.throws(() => V.validateFeePerKb(Infinity), TypeError)
        assert.throws(() => V.validateFeePerKb(NaN), TypeError)
        assert.throws(() => V.validateFeePerKb(0), RangeError)
        assert.throws(() => V.validateFeePerKb(-5), RangeError)
    })

    it('rejects negative dust', () => {
        assert.throws(() => V.validateDust(-1), RangeError)
        assert.throws(() => V.validateDust('xyz'), TypeError)
    })
})

describe('Security: validateEncoding', () => {
    it('rejects an unknown/garbage encoding (no injection into the switch)', () => {
        assert.throws(() => V.validateEncoding('OP_RETURN; DROP'), TypeError)
        assert.throws(() => V.validateEncoding('p2sh'), TypeError) // case-sensitive
        assert.throws(() => V.validateEncoding(42), TypeError)
    })

    it('accepts each canonical encoding exactly', () => {
        for (const e of V.VALID_ENCODINGS) assert.strictEqual(V.validateEncoding(e), e)
    })
})

describe('Security: validateCustomOutputs / validateFeeQuote', () => {
    it('rejects an over-limit custom-output set', () => {
        const many = Array.from({ length: V.MAX_CUSTOM_OUTPUTS + 1 }, () => ({ address: 'x', value: 1 }))
        assert.throws(() => V.validateCustomOutputs(many), RangeError)
    })

    it('rejects custom output with over-length address or negative value', () => {
        assert.throws(() => V.validateCustomOutputs([{ address: 'a'.repeat(101), value: 1 }]), TypeError)
        assert.throws(() => V.validateCustomOutputs([{ address: 'addr', value: -1 }]), RangeError)
    })

    it('rejects a feeQuote with non-positive or over-max amount (via validateAll — feeQuote is internal-only)', () => {
        assert.throws(() => V.validateAll({ feeQuote: { address: 'a', amount: 0 } }), RangeError)
        assert.throws(() => V.validateAll({ feeQuote: { address: 'a', amount: V.MAX_FEE_SATOSHIS + 1 } }), RangeError)
        assert.throws(() => V.validateAll({ feeQuote: { address: '', amount: 10 } }), TypeError)
    })
})

describe('Security: validateP2shParams (paired-secret integrity)', () => {
    it('rejects supplying only one of p2shHash / p2shHex', () => {
        assert.throws(() => V.validateP2shParams(HEX64, null), TypeError)
        assert.throws(() => V.validateP2shParams(null, 'deadbeef'), TypeError)
    })

    it('rejects a non-64-hex p2shHash', () => {
        assert.throws(() => V.validateP2shParams(SQLI, 'deadbeef'), TypeError)
    })

    it('returns nulls when both omitted', () => {
        assert.deepStrictEqual(V.validateP2shParams(null, null), { p2shHash: null, p2shHex: null })
    })
})

describe('Security: validateAll end-to-end', () => {
    it('rejects a request object that is not an object', () => {
        assert.throws(() => V.validateAll(null), TypeError)
        assert.throws(() => V.validateAll('string'), TypeError)
    })

    it('surfaces the first hostile field and never returns attacker strings raw', () => {
        const out = V.validateAll({
            utxos: [{ txid: HEX64, vout: 0, value: '2100; DROP', scriptPubKey: '00' }],
            pubkey: 'a'.repeat(34),
            fee: '1000 OR 1=1',
            encoding: 'OP_RETURN'
        })
        assert.strictEqual(out.utxos[0].value, 2100)
        assert.strictEqual(out.fee, 1000)
        assert.strictEqual(typeof out.utxos[0].value, 'number')
    })
})

describe('Security: validation integrity (regex anchors + set membership)', () => {
    // These pin exact behaviour so a weakened guard (a dropped regex anchor or a
    // corrupted encoding whitelist) cannot pass silently — the kinds of change a
    // refactor or a malicious edit could introduce.

    it('accepts each canonical encoding by exact name and rejects the empty string', () => {
        assert.strictEqual(V.validateEncoding('OP_RETURN'), 'OP_RETURN')
        assert.strictEqual(V.validateEncoding('P2SH'), 'P2SH')
        assert.strictEqual(V.validateEncoding('MULTISIGN'), 'MULTISIGN')
        assert.strictEqual(V.validateEncoding('P2WSH'), 'P2WSH')
        assert.throws(() => V.validateEncoding(''), TypeError)
    })

    it('anchors the compressedPubKey regex (rejects leading and trailing junk)', () => {
        const body = '02' + 'a'.repeat(64)
        assert.strictEqual(V.validateCompressedPubKey(body), body)
        assert.throws(() => V.validateCompressedPubKey('zz' + body), TypeError) // ^ anchor
        assert.throws(() => V.validateCompressedPubKey(body + 'zz'), TypeError) // $ anchor
    })

    it('anchors the 64-hex txid regex (rejects 64 hex embedded in a longer string)', () => {
        const hex = 'a'.repeat(64)
        assert.throws(() => V.validateUtxoEntry({ txid: 'zz' + hex, vout: 0, value: 1, scriptPubKey: '00' }, 0), TypeError) // ^ anchor
        assert.throws(() => V.validateUtxoEntry({ txid: hex + 'zz', vout: 0, value: 1, scriptPubKey: '00' }, 0), TypeError) // $ anchor
    })

    it('anchors the p2shHash regex the same way', () => {
        const hex = 'a'.repeat(64)
        assert.throws(() => V.validateP2shParams('zz' + hex, 'deadbeef'), TypeError)
        assert.throws(() => V.validateP2shParams(hex + 'zz', 'deadbeef'), TypeError)
    })
})
