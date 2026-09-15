// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
  assert,
  bitcoin,
  TXID_A,
  makeSegwitUtxo,
  makeEncoder,
  TEST_ADDRESS
} = require('./fixtures/transaction')

// The builder is a supported library entry point, and api.js's validateAll sits
// in front of the JSON-RPC surface only. Every payload guard asserted here is
// asserted through encoder.createTransaction() with NO validator call in front
// of it: a suite that only exercises validator.validateAll stays green with the
// guards absent from the builder, which is exactly how these bypasses shipped.
const nulldataOutputs = (psbt) =>
  psbt.txOutputs.filter((o) => bitcoin.script.toASM(o.script).startsWith('OP_RETURN'))

describe('XChainEncoder.createTransaction() payload guards (library boundary)', () => {
  // Latin-1 truncation: U+0100 silently became the byte 0x00 on a fee-paid
  // transaction, and the compiled-size ceiling cannot see it (the length does
  // not change). Written as fromCharCode so the source carries no literal high
  // character, matching validator.js's firstNonLatin1.
  it('rejects a rawData code unit above U+00FF instead of truncating it', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        'SEND|0|TOKEN|1|' + TEST_ADDRESS, String.fromCharCode(0x0100), 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      (err) => err instanceof RangeError && /U\+00FF/.test(err.message)
    )
  })

  it('rejects a `data` string that is not well-formed Unicode', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        'SEND|\uD800|x', null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      (err) => err instanceof RangeError && /well-formed/.test(err.message)
    )
  })

  // Minimal-op canonicalization: a lone 0x05 compiles to a bare OP_5 and the
  // decoder's Buffer.isBuffer element test discards it.
  it('rejects a single minimal-opcode rawData byte', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        'FILE|0|doc', String.fromCharCode(0x05), 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      (err) => err instanceof RangeError && /rawData/.test(err.message)
    )
  })

  it('rejects a single minimal-opcode `data` byte', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        String.fromCharCode(0x05), null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      (err) => err instanceof RangeError && /data/.test(err.message)
    )
  })
})

describe('XChainEncoder.createTransaction() payload guards (library boundary)', () => {
  // The guards must close a data-loss path without narrowing the shapes the
  // library already builds. These four are the ones the two placements could
  // plausibly have broken.
  it('still builds the deliberately-supported rawData-only shape', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      null, 'rawpayload', 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(nulldataOutputs(result.psbt).length, 1)
  })

  it('still builds a payment-only transaction with no payload at all', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS,
      [{ address: TEST_ADDRESS, value: '1000000' }],
      null, null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.strictEqual(nulldataOutputs(result.psbt).length, 0)
  })

  it('still builds an ordinary multi-byte data + rawData payload', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      'FILE|0|doc', 'file-bytes-here', 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.ok(result.psbt instanceof bitcoin.Psbt)
  })
})

describe('XChainEncoder.createTransaction() payload guards (library boundary)', () => {
  // The decodability guard must see Buffer inputs too. A Buffer is copied byte
  // for byte, which is why the latin-1 guard can stay string-only, but
  // canonicalization is a property of the COMPILED push, so a one-byte Buffer
  // in the minimal-op range loses everything the same way its string spelling
  // does. Scoping this guard to strings left the hole open on exactly the
  // surface the finding is about (direct library callers).
  it('rejects a single minimal-opcode rawData byte passed as a Buffer', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        'FILE|0|doc', Buffer.from([0x05]), 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      (err) => err instanceof RangeError && /rawData/.test(err.message)
    )
  })

  it('rejects a single minimal-opcode `data` byte passed as a Buffer', async () => {
    const encoder = makeEncoder()
    await assert.rejects(
      () => encoder.createTransaction(
        [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
        Buffer.from([0x05]), null, 10000, false, null, TEST_ADDRESS,
        null, null, null, true, 0.00001
      ),
      (err) => err instanceof RangeError && /data/.test(err.message)
    )
  })

  // A multi-byte Buffer rawData is copied byte-for-byte by
  // Buffer.from(rawData,'binary'), so nothing is lost and nothing here may
  // start refusing it: the guards close a data-loss path, they do not become
  // argument-shape policy.
  it('still accepts a Buffer rawData from a library caller', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      'FILE|0|doc', Buffer.from('file-bytes-here', 'binary'), 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.ok(result.psbt instanceof bitcoin.Psbt)
  })
})

// The ACTION-name parity gap. validateAll refuses an unrecognized leading
// token on the JSON-RPC path, so the direct library entry point is the one
// surface that can compile and pay for a payload every decoder then drops. The
// builder reports it instead of refusing, because a non-ACTION payload is a
// supported library shape; what must not happen is the silence.
const warningCodes = (result) => (result.warnings || []).map((w) => w.code)

describe('XChainEncoder.createTransaction() payload guards (library boundary)', () => {
  it('warns a library caller whose data leads with an unknown ACTION name', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      'TRANSFRE|0|TOKEN|1|^2', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.ok(result.psbt instanceof bitcoin.Psbt, 'the build must still succeed')
    assert.ok(warningCodes(result).includes('UNKNOWN_ACTION_NAME'))
    assert.ok(/TRANSFRE/.test(result.warnings.find((w) => w.code === 'UNKNOWN_ACTION_NAME').message))
  })

  it('warns when an unknown ACTION name arrives as a Buffer', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      Buffer.from('TRANSFRE|0|TOKEN|1|^2', 'utf8'), null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.ok(warningCodes(result).includes('UNKNOWN_ACTION_NAME'))
  })
})

describe('XChainEncoder.createTransaction() payload guards (library boundary)', () => {
  // The negative controls: a canonical name and an alias must produce NO
  // advisory, or the warning is decoration rather than a signal.
  it('does not warn on a canonical ACTION name', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      'SEND|0|TOKEN|1|^2', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.ok(!warningCodes(result).includes('UNKNOWN_ACTION_NAME'))
  })

  it('does not warn on a known ACTION alias', async () => {
    const encoder = makeEncoder()
    const result = await encoder.createTransaction(
      [makeSegwitUtxo(TXID_A, 0, 100000000)], TEST_ADDRESS, null,
      'TRANSFER|0|TOKEN|1|^2', null, 10000, false, null, TEST_ADDRESS,
      null, null, null, true, 0.00001
    )
    assert.ok(!warningCodes(result).includes('UNKNOWN_ACTION_NAME'))
  })
})
