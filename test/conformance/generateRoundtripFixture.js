// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Generator for the shared encoder->decoder roundtrip conformance fixture.
// Emits test/fixtures/roundtrip-conformance.json, the single
// golden artifact consumed by BOTH the encoder suite (drift guard) and the
// decoder suite (real-decoder decode of encoder-built bytes). Regenerate with:
//   node test/conformance/generateRoundtripFixture.js
// and review the diff. The fixture is deterministic: bitcoin.script.compile and
// the AES-128-CTR obfuscation are pure functions of their inputs.
//
// It pins the exact byte path where two shipped cross-service bugs lived:
//   rawData-only  -> compile([<empty>, rawData]) emits a leading OP_0 the
//                    decoder's Buffer gate discards (fee-paid data lost).
//   1-byte minimal-op payload -> compile canonicalizes a lone 0x01-0x10 / 0x81
//                    byte to a bare opcode the decoder discards.
// Both are captured as `gate: "dropped"` cases so the fixture has teeth: when
// the flag-day decoder-acceptance change lands, those expectations flip and the
// conformance test forces the fixture to be updated in lockstep.

'use strict'

const fs = require('fs')
const path = require('path')
const bitcoin = require('bitcoinjs-lib')
const XChainEncoder = require('../../src/XChainEncoder')
const { MAX_COMPILED_ACTION_DATA_LENGTH } = require('../../src/validator')

const MAGIC_WORD = 'XCHN'
const MAGIC_BUFFER = Buffer.from(MAGIC_WORD, 'utf8')

// A deterministic 64-hex "first input txid" used as the obfuscation key.
const FIRST_INPUT_TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'

// Mirrors XChainEncoder.createTransaction: data is UTF-8, rawData is Latin-1,
// and the on-wire ACTION push is bitcoin.script.compile([dataBuf, rawDataBuf?]).
function compileAction (data, rawData) {
  const dataBuffer = Buffer.from(data == null ? '' : data, 'utf8')
  const toCompile = [dataBuffer]
  if (rawData != null) toCompile.push(Buffer.from(rawData, 'binary'))
  return bitcoin.script.compile(toCompile)
}

// The OP_RETURN wire payload as prepareData + the obfuscation step build it:
// MAGIC_WORD prepended to the compiled ACTION push, then AES-128-CTR obfuscated
// under the first input's txid.
async function buildObfuscatedOpReturn (encoder, compiled) {
  const withMagic = Buffer.concat([MAGIC_BUFFER, compiled])
  return encoder.obfuscate(withMagic, FIRST_INPUT_TXID)
}

// The decoder's documented arbiter gate (XChainDecoder.js ~689-718): the leading
// decompiled element must be a Buffer or the whole payload is discarded; the
// second element is only taken as rawData when it too is a Buffer.
function gateOutcome (compiled) {
  const decompiled = bitcoin.script.decompile(compiled)
  if (decompiled == null || decompiled.length === 0) return { gate: 'dropped', data: null, rawData: null }
  if (!Buffer.isBuffer(decompiled[0])) return { gate: 'dropped', data: null, rawData: null }
  const data = decompiled[0]
  let rawData = null
  if (decompiled.length > 1 && Buffer.isBuffer(decompiled[1])) rawData = decompiled[1]
  return { gate: 'accepted', data, rawData }
}

// Deterministic third (real) pubkey slot for MULTISIGN 1-of-3 outputs. Only
// structurally validated by bitcoin.payments.p2ms (33 bytes, 0x02/0x03 prefix).
const THIRD_PUBKEY = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 0x7e)])

// Deterministic P2SH/P2WSH signer address (hash160 = 20 x 0x11) built for the
// encoder's own network so prepareData's fromBase58Check round-trips.
function signerAddress (encoder) {
  return bitcoin.address.toBase58Check(Buffer.alloc(20, 0x11), encoder.network.pubKeyHash)
}

// Deterministic compressed signer pubkey for the TAPROOT lane. prepareData
// strips the 0x02/0x03 prefix and uses the remaining 32 bytes as the envelope
// leaf's internal key, so this is what the decoder's grammar walk expects to
// find after OP_ENDIF.
const ENVELOPE_COMPRESSED_PUBKEY = '02' + '7c'.repeat(32)

// Walk an encoder-emitted envelope tapscript with the SAME grammar the decoder
// pattern-matches (detectEnvelopeWitness): OP_FALSE OP_IF <"XCHN"> <0x00>
// <payload push 1..n> OP_ENDIF <32-byte key> OP_CHECKSIG. Returns the payload
// pushes in order. Throws on any divergence, so the generator itself refuses to
// emit a fixture case the decoder would not recognize.
function envelopePayloadPushes (envelopeScript, internalPubkey) {
  const d = bitcoin.script.decompile(envelopeScript)
  if (d == null || d.length < 8) throw new Error('envelope tapscript did not decompile to the envelope grammar')
  let i = 0
  if (d[i++] !== bitcoin.opcodes.OP_0) throw new Error('envelope leaf must open with OP_FALSE')
  if (d[i++] !== bitcoin.opcodes.OP_IF) throw new Error('envelope leaf must open with OP_IF')
  if (!Buffer.isBuffer(d[i]) || !d[i].equals(MAGIC_BUFFER)) throw new Error('envelope leaf must carry the cleartext magic')
  i++
  if (!Buffer.isBuffer(d[i]) || d[i].length !== 1 || d[i][0] !== 0x00) throw new Error('envelope leaf must carry format byte v0')
  i++
  const pushes = []
  while (i < d.length && Buffer.isBuffer(d[i])) { pushes.push(d[i]); i++ }
  // A payload chunk that decompiled to a bare opcode stops the walk early and
  // trips this check: exactly the failure prepareData's final-chunk rebalance
  // exists to prevent, so the generator catches a rebalance regression here
  // rather than shipping a fixture the decoder cannot read.
  if (pushes.length === 0) throw new Error('envelope leaf carries no payload push')
  if (d[i++] !== bitcoin.opcodes.OP_ENDIF) throw new Error('envelope payload did not terminate at OP_ENDIF (a chunk decompiled to a bare opcode)')
  if (!Buffer.isBuffer(d[i]) || !d[i].equals(internalPubkey)) throw new Error('envelope leaf tail must carry the 32-byte internal key')
  i++
  if (d[i++] !== bitcoin.opcodes.OP_CHECKSIG) throw new Error('envelope leaf must end with OP_CHECKSIG')
  if (i !== d.length) throw new Error('envelope leaf carries trailing elements')
  return pushes
}

// BET. DETAILS carries the whole market definition on-chain as
// base64 JSON, which makes a create action the largest routine user payload the
// encoder produces and forces a multi-chunk P2WSH. Built deterministically here
// so the encoder->decoder roundtrip is pinned at the DETAILS cap rather than at
// a hand-picked size that drifts away from the real ceiling.
//
// MAX_BET_DETAILS_LENGTH is DECODED bytes (xchain-documentation/protocol/actions/
// BET.md). The spec originally set it to 8192 and that value was un-broadcastable:
// base64 adds a third, and the whole ACTION string shares one
// MAX_COMPILED_ACTION_DATA_LENGTH ceiling with every other field, so a max-size
// market compiled to ~12.8KB against an 8KB cap. 4096 is the corrected value and
// the case below is what holds it honest from the encoder side.
const MAX_BET_DETAILS_LENGTH = 4096

// A DETAILS payload of exactly MAX_BET_DETAILS_LENGTH decoded bytes: real JSON
// with its description padded out to hit the cap on the nose.
function maxBetDetails () {
  const skeleton = { title: 'Who wins Superbowl LX?', outcomes: ['Chiefs', '49ers'], description: '' }
  const padLength = MAX_BET_DETAILS_LENGTH - Buffer.byteLength(JSON.stringify(skeleton), 'utf8')
  if (padLength < 0) throw new Error('DETAILS skeleton already exceeds MAX_BET_DETAILS_LENGTH')
  skeleton.description = 'd'.repeat(padLength)
  const json = JSON.stringify(skeleton)
  if (Buffer.byteLength(json, 'utf8') !== MAX_BET_DETAILS_LENGTH)
    throw new Error(`DETAILS is ${Buffer.byteLength(json, 'utf8')} bytes, expected exactly ${MAX_BET_DETAILS_LENGTH}`)
  return Buffer.from(json, 'utf8').toString('base64')
}

const BET_CREATE_MAX_DETAILS =
  'BET|0|Superbowl LX winner|Chiefs,49ers|PEPECASH|1.00|1770000000|||||' +
  maxBetDetails() + '|Bet on the big game'

const CASES = [
  { name: 'action-only (SEND)', data: '{"op":"SEND","qty":100}', rawData: null },
  // The routine small BET: a wager fits an OP_RETURN with room to spare.
  { name: 'BET place-bet (OP_RETURN sized)', data: 'BET|2|1234|0|25.00000000|Chiefs all day', rawData: null },
  { name: 'action + rawData (ISSUE + metadata)', data: 'ISSUE|0|TICK', rawData: 'extra-metadata-bytes' },
  { name: 'action + binary rawData (high bytes)', data: 'FILE|0|doc', rawData: '\x00\x01\xff\x80\x7f' },
  { name: 'rawData-only OP_0 leading push (currently dropped)', data: '', rawData: 'orphan-raw-payload' },
  { name: '1-byte minimal-op data 0x05 (currently dropped)', data: '\x05', rawData: null },
  { name: '1-byte non-minimal data 0x41 (safe single push)', data: 'A', rawData: null },
  { name: 'empty data-only (payment-only / no-ACTION, OP_0)', data: '', rawData: null }
]

// MULTISIGN cases. prepareData zero-pads every 64-byte slot; the pad
// survives deobfuscation and is discarded only by the payload's self-describing
// compiled-push length at final decompile, so the pinned expectations exercise
// the decompile-length pad strip explicitly.
const MULTISIGN_CASES = [
  // 1 slot, short chunk -> heavy zero pad; pad bytes decompile to trailing OP_0s.
  { name: 'MULTISIGN single slot with pad (SEND)', data: '{"op":"SEND","qty":100}', rawData: null },
  // 3 slots (compiled ~150 bytes / 60-byte chunks); multi-output reassembly + rawData.
  { name: 'MULTISIGN three slots + rawData', data: 'ISSUE|0|TICK|' + 'x'.repeat(80), rawData: 'meta-' + 'y'.repeat(45) },
  // Compiled length an exact multiple of 60 -> final slot is a full 64 bytes, zero pad bytes.
  { name: 'MULTISIGN exact slot boundary (no pad)', data: 'B'.repeat(118), rawData: null }
]

// P2SH/P2WSH multi-chunk cases, incl. the 1-byte final-chunk rebalance
// boundary: compiled length 477 with last byte 0x05 splits 476+1, and prepareData
// must repartition to 475+2 so bitcoin.script.compile's asMinimalOP cannot turn
// the lone 0x05 into a bare OP_5 the decoder's redeem-script Buffer gate drops.
const P2SH_CASES = [
  { name: 'P2SH two chunks (no rebalance)', encoding: 'P2SH', data: 'C'.repeat(600), rawData: null, expectedChunkLengths: [476, 127] },
  { name: 'P2SH final-chunk rebalance boundary (last byte 0x05)', encoding: 'P2SH', data: 'D'.repeat(473) + '\x05', rawData: null, expectedChunkLengths: [475, 2] },
  { name: 'P2WSH two chunks + rawData', encoding: 'P2WSH', data: 'E'.repeat(300), rawData: 'z'.repeat(400), expectedChunkLengths: [476, 230] },
  // BET create at the DETAILS cap: the largest routine user ACTION, exercising
  // the deep multi-chunk path end to end (encode -> chunk -> reassemble ->
  // decode) at real field sizes rather than with filler bytes.
  { name: 'P2WSH BET create at the DETAILS cap', encoding: 'P2WSH', data: BET_CREATE_MAX_DETAILS, rawData: null, expectedChunkLengths: [476, 476, 476, 476, 476, 476, 476, 476, 476, 476, 476, 319] }
]

// Alias-rewrite cases: on-wire payloads carrying a short-form ACTION
// name the decoder must canonicalize (canonicalizeActionPayload) before the
// VALID_ACTION_NAMES gate, so the DB never stores the alias spelling.
// A single raw push of N bytes (N >= 256) compiles to N + 3: the OP_PUSHDATA2
// opcode plus a 2-byte little-endian length. Pick N so the compiled push is
// exactly the ceiling, i.e. the widest on-wire ACTION the size gate accepts.
const CEILING_PUSH_DATA_BYTES = MAX_COMPILED_ACTION_DATA_LENGTH - 3
const CAST_CEILING_PREFIX = 'CAST|0|'
const CAST_CEILING_DATA = CAST_CEILING_PREFIX +
  'a'.repeat(CEILING_PUSH_DATA_BYTES - CAST_CEILING_PREFIX.length)

const ALIAS_CASES = [
  { name: 'alias rewrite TRANSFER -> SEND', data: 'TRANSFER|0|TICK|addr|100', rawData: null, expectedRawActionName: 'TRANSFER', expectedActionName: 'SEND' },
  { name: 'alias rewrite MSG -> MESSAGE', data: 'MSG|0|hello', rawData: null, expectedRawActionName: 'MSG', expectedActionName: 'MESSAGE' },
  // Alias sitting at the compiled-size ceiling. The CAST push is exactly
  // MAX_COMPILED_ACTION_DATA_LENGTH on the wire, so it passes the size gate; the
  // decoder then rewrites CAST -> BROADCAST (+5 bytes) during canonicalization,
  // which runs AFTER that gate, so the stored canonical record lands past the
  // numeric cap. This pins on the encoder half that the cap bounds the WIRE
  // (alias) form, never the stored record; the decoder half is pinned by
  // xchain-decoder/test/unit/aliasExpansionBoundary.test.js. canonicalDataHex
  // below is the >cap BROADCAST record the roundtrip is expected to store.
  { name: 'alias rewrite CAST -> BROADCAST at the compiled ceiling', data: CAST_CEILING_DATA, rawData: null, expectedRawActionName: 'CAST', expectedActionName: 'BROADCAST' }
]

// TAPROOT-envelope cases. This is the one lane where the two services measure
// the same bytes with DIFFERENT machinery on purpose (the encoder corrects for
// the OP_PUSHDATA4 band in envelopePushSize; the decoder refuses to re-measure
// an envelope payload at all), so it is also the lane where an unpinned
// roundtrip costs the most. The arithmetic half of that asymmetry is pinned
// directly by xchain-decoder/test/unit/compiledPushSizeConformance.test.js's
// envelope band block; these cases pin the STRUCTURAL half - an
// encoder-emitted envelope reaching the stored record - which no test reached
// before. Deliberately no case above 65,535 bytes: this artifact is vendored
// verbatim into xchain-decoder and xchain-sdk, so a ceiling-sized payload would
// add ~780 KB of hex to three repos forever to re-assert arithmetic the band
// block already asserts for free.
//
// compiled length picks the chunk split: prepareData cuts the payload into
// 520-byte pushes (TAPROOT_ENVELOPE_CHUNK_SIZE).
const ENVELOPE_ACTION_PREFIX = 'BROADCAST|0|'
const ENVELOPE_MULTI_CHUNK_DATA = ENVELOPE_ACTION_PREFIX +
  'b'.repeat(1200 - ENVELOPE_ACTION_PREFIX.length)           // compiled 1203 = 2*520 + 163
// A real BROADCAST, not filler: the rebalance case has to reach the stored
// record like the others, or it would only ever pin the rejected-ACTION branch.
const ENVELOPE_REBALANCE_DATA = ENVELOPE_ACTION_PREFIX +
  'd'.repeat(1038 - ENVELOPE_ACTION_PREFIX.length - 1) + '\x05'  // compiled 1041 = 2*520 + 1

const ENVELOPE_CASES = [
  { name: 'envelope action-only (SEND)', data: 'SEND|0|TICK|mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q|100', rawData: null, expectedChunkLengths: [51] },
  { name: 'envelope action + rawData (ISSUE + metadata)', data: 'ISSUE|0|TICK', rawData: 'extra-metadata-bytes', expectedChunkLengths: [34] },
  // Multi-chunk: the payload spans three 520-byte pushes the decoder must
  // reassemble in order before it decompiles anything.
  { name: 'envelope multi-chunk BROADCAST', data: ENVELOPE_MULTI_CHUNK_DATA, rawData: null, expectedChunkLengths: [520, 520, 163] },
  // The envelope lane's own asMinimalOP hazard: a compiled length of 520n + 1
  // whose final byte is 0x01-0x10 would leave a lone minimal-op chunk that
  // bitcoin.script.compile canonicalizes to a bare opcode, breaking the
  // decoder's payload walk. prepareData repartitions to 519 + 2; nothing pinned
  // that branch before, on either side of the seam.
  { name: 'envelope final-chunk rebalance boundary (last byte 0x05)', data: ENVELOPE_REBALANCE_DATA, rawData: null, expectedChunkLengths: [520, 519, 2] }
]

async function buildMultisignCase (encoder, c) {
  const compiled = compileAction(c.data, c.rawData)
  const prepared = encoder.prepareData(compiled, 'MULTISIGN')
  const slots = []
  const reassembledParts = []
  for (const slot of prepared.dataBufferArray) {
    if (slot.length !== 64) throw new Error(`${c.name}: MULTISIGN slot is ${slot.length} bytes, expected 64`)
    const obfuscated = await encoder.obfuscate(slot, FIRST_INPUT_TXID)
    const pubkey1 = await encoder.dataToPubkey(obfuscated.slice(0, 32))
    const pubkey2 = await encoder.dataToPubkey(obfuscated.slice(32, obfuscated.length))
    const outputScript = bitcoin.payments.p2ms({
      m: 1,
      pubkeys: [pubkey1, pubkey2, THIRD_PUBKEY],
      network: encoder.network
    }).output
    slots.push({
      plaintextSlotHex: slot.toString('hex'),
      obfuscatedSlotHex: obfuscated.toString('hex'),
      pubkey1Hex: pubkey1.toString('hex'),
      pubkey2Hex: pubkey2.toString('hex'),
      outputScriptHex: outputScript.toString('hex')
    })
    // What the decoder accumulates per output: deobfuscated slot minus magic
    // (the zero pad stays in until the final decompile strips it by length).
    reassembledParts.push(slot.subarray(MAGIC_BUFFER.length))
  }
  const reassembled = Buffer.concat(reassembledParts)
  const outcome = gateOutcome(reassembled)
  return {
    name: c.name,
    encoding: 'MULTISIGN',
    firstInputTxid: FIRST_INPUT_TXID,
    thirdPubkeyHex: THIRD_PUBKEY.toString('hex'),
    inputDataHex: Buffer.from(c.data, 'utf8').toString('hex'),
    inputRawDataHex: c.rawData == null ? null : Buffer.from(c.rawData, 'binary').toString('hex'),
    compiledHex: compiled.toString('hex'),
    reassembledHex: reassembled.toString('hex'),
    slots,
    expected: {
      gate: outcome.gate,
      dataHex: outcome.data == null ? null : outcome.data.toString('hex'),
      rawDataHex: outcome.rawData == null ? null : outcome.rawData.toString('hex')
    }
  }
}

async function buildP2shCase (encoder, c) {
  const compiled = compileAction(c.data, c.rawData)
  const pubKey = signerAddress(encoder)
  const prepared = encoder.prepareData(compiled, c.encoding, pubKey)
  const redeemScriptsHex = []
  const chunkLengths = []
  const reassembledParts = []
  for (const redeemScript of prepared.dataBufferArray) {
    const decompiled = bitcoin.script.decompile(redeemScript)
    if (!decompiled || !Buffer.isBuffer(decompiled[0])) {
      throw new Error(`${c.name}: redeem script leading element is not a Buffer (rebalance regression)`)
    }
    redeemScriptsHex.push(redeemScript.toString('hex'))
    chunkLengths.push(decompiled[0].length)
    reassembledParts.push(decompiled[0])
  }
  if (JSON.stringify(chunkLengths) !== JSON.stringify(c.expectedChunkLengths)) {
    throw new Error(`${c.name}: chunk lengths ${JSON.stringify(chunkLengths)} != expected ${JSON.stringify(c.expectedChunkLengths)} (case no longer covers the intended boundary)`)
  }
  const reassembled = Buffer.concat(reassembledParts)
  if (!reassembled.equals(compiled)) {
    throw new Error(`${c.name}: chunk concatenation diverges from the compiled payload`)
  }
  // The reveal tx's marker OP_RETURN: obfuscated "XCHN" + "p2sh"/"p2wsh"
  // (createTransaction's p2shHash branch), which routes the decoder into the
  // per-input redeem/witness-script reassembly loop.
  const markerPlain = Buffer.concat([MAGIC_BUFFER, Buffer.from(c.encoding.toLowerCase(), 'utf8')])
  const markerOpReturn = await encoder.obfuscate(markerPlain, FIRST_INPUT_TXID)
  const outcome = gateOutcome(reassembled)
  return {
    name: c.name,
    encoding: c.encoding,
    firstInputTxid: FIRST_INPUT_TXID,
    pubKeyBase58: pubKey,
    inputDataHex: Buffer.from(c.data, 'utf8').toString('hex'),
    inputRawDataHex: c.rawData == null ? null : Buffer.from(c.rawData, 'binary').toString('hex'),
    compiledHex: compiled.toString('hex'),
    markerOpReturnHex: markerOpReturn.toString('hex'),
    redeemScriptsHex,
    chunkLengths,
    expected: {
      gate: outcome.gate,
      dataHex: outcome.data == null ? null : outcome.data.toString('hex'),
      rawDataHex: outcome.rawData == null ? null : outcome.rawData.toString('hex')
    }
  }
}

async function buildAliasCase (encoder, c) {
  const compiled = compileAction(c.data, c.rawData)
  const obfuscated = await buildObfuscatedOpReturn(encoder, compiled)
  const outcome = gateOutcome(compiled)
  if (outcome.gate !== 'accepted') throw new Error(`${c.name}: alias case must survive the arbiter gate`)
  const pipeIndex = c.data.indexOf('|')
  const canonicalData = c.expectedActionName + c.data.slice(pipeIndex)
  return {
    name: c.name,
    encoding: 'OP_RETURN',
    firstInputTxid: FIRST_INPUT_TXID,
    inputDataHex: Buffer.from(c.data, 'utf8').toString('hex'),
    compiledHex: compiled.toString('hex'),
    obfuscatedOpReturnHex: obfuscated.toString('hex'),
    expected: {
      dataHex: outcome.data.toString('hex'),
      rawActionName: c.expectedRawActionName,
      actionName: c.expectedActionName,
      canonicalDataHex: Buffer.from(canonicalData, 'utf8').toString('hex')
    }
  }
}

async function buildEnvelopeCase (encoder, c) {
  const compiled = compileAction(c.data, c.rawData)
  const prepared = encoder.prepareData(compiled, 'TAPROOT', signerAddress(encoder), ENVELOPE_COMPRESSED_PUBKEY)
  if (prepared.dataBufferArray.length !== 1) {
    throw new Error(`${c.name}: TAPROOT prepareData must return exactly one tapscript, got ${prepared.dataBufferArray.length}`)
  }
  const envelopeScript = prepared.dataBufferArray[0]
  const pushes = envelopePayloadPushes(envelopeScript, prepared.internalPubkey)
  const chunkLengths = pushes.map((p) => p.length)
  if (JSON.stringify(chunkLengths) !== JSON.stringify(c.expectedChunkLengths)) {
    throw new Error(`${c.name}: chunk lengths ${JSON.stringify(chunkLengths)} != expected ${JSON.stringify(c.expectedChunkLengths)} (case no longer covers the intended boundary)`)
  }
  // The payload is raw by design (envelope spec §3.3: no obfuscation step), so
  // the decoder's reassembly is a plain concatenation and must reproduce the
  // compiled stream byte for byte.
  const reassembled = Buffer.concat(pushes)
  if (!reassembled.equals(compiled)) {
    throw new Error(`${c.name}: envelope chunk concatenation diverges from the compiled payload`)
  }
  const outcome = gateOutcome(reassembled)
  return {
    name: c.name,
    encoding: 'TAPROOT',
    firstInputTxid: FIRST_INPUT_TXID,
    inputDataHex: Buffer.from(c.data, 'utf8').toString('hex'),
    inputRawDataHex: c.rawData == null ? null : Buffer.from(c.rawData, 'binary').toString('hex'),
    compiledHex: compiled.toString('hex'),
    compressedPubKey: ENVELOPE_COMPRESSED_PUBKEY,
    internalPubkeyHex: prepared.internalPubkey.toString('hex'),
    envelopeScriptHex: envelopeScript.toString('hex'),
    chunkLengths,
    expected: {
      gate: outcome.gate,
      dataHex: outcome.data == null ? null : outcome.data.toString('hex'),
      rawDataHex: outcome.rawData == null ? null : outcome.rawData.toString('hex')
    }
  }
}

async function main () {
  const encoder = new XChainEncoder('bitcoin-regtest', '127.0.0.1', '8333', 'rpc', 'rpc', '', '')
  const cases = []
  for (const c of CASES) {
    const compiled = compileAction(c.data, c.rawData)
    const obfuscated = await buildObfuscatedOpReturn(encoder, compiled)
    const outcome = gateOutcome(compiled)
    cases.push({
      name: c.name,
      encoding: 'OP_RETURN',
      firstInputTxid: FIRST_INPUT_TXID,
      // Inputs (hex) so the fixture is language/encoding-agnostic to consume.
      inputDataHex: Buffer.from(c.data == null ? '' : c.data, 'utf8').toString('hex'),
      inputRawDataHex: c.rawData == null ? null : Buffer.from(c.rawData, 'binary').toString('hex'),
      // Encoder-built artifacts.
      compiledHex: compiled.toString('hex'),
      obfuscatedOpReturnHex: obfuscated.toString('hex'),
      // Expected decode outcome under the decoder's arbiter gate.
      expected: {
        gate: outcome.gate,
        dataHex: outcome.data == null ? null : outcome.data.toString('hex'),
        rawDataHex: outcome.rawData == null ? null : outcome.rawData.toString('hex')
      }
    })
  }

  const multisignCases = []
  for (const c of MULTISIGN_CASES) multisignCases.push(await buildMultisignCase(encoder, c))

  const p2shCases = []
  for (const c of P2SH_CASES) p2shCases.push(await buildP2shCase(encoder, c))

  const aliasCases = []
  for (const c of ALIAS_CASES) aliasCases.push(await buildAliasCase(encoder, c))

  const envelopeCases = []
  for (const c of ENVELOPE_CASES) envelopeCases.push(await buildEnvelopeCase(encoder, c))

  const fixture = {
    _comment: 'Shared encoder->decoder roundtrip conformance fixture, covering OP_RETURN, ' +
      'MULTISIGN slots, P2SH/P2WSH multi-chunk (incl. the final-chunk rebalance boundary), ' +
      'alias-rewrite and TAPROOT-envelope cases. Generated by ' +
      'test/conformance/generateRoundtripFixture.js; regenerate ' +
      'and review on change. Consumed by the encoder drift-guard test and the decoder real-decode ' +
      'conformance test. gate "dropped" cases pin known cross-service data-loss shapes; when the ' +
      'flag-day decoder-acceptance change lands those expectations flip.',
    magicWord: MAGIC_WORD,
    cases,
    multisignCases,
    p2shCases,
    aliasCases,
    envelopeCases
  }

  const outPath = path.join(__dirname, '..', 'fixtures', 'roundtrip-conformance.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`wrote ${cases.length} OP_RETURN + ${multisignCases.length} MULTISIGN + ` +
    `${p2shCases.length} P2SH/P2WSH + ${aliasCases.length} alias + ` +
    `${envelopeCases.length} TAPROOT envelope cases to ${outPath}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
