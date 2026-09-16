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
 *
 * XChain Encoder - Encoder Class
 *
 * This file handles starting the encoder and generating transactions
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib');
const { OP_RETURN_SIZE, P2SH_SIZE, PW2SH_SIZE, MULTISIGN_SIZE, TAPROOT_ENVELOPE_CHUNK_SIZE, TAPROOT_ENVELOPE_FORMAT_V0, Encoding } = require('./constants.js')
const { resolveCallerHash160 } = require('./request_resolution.js')

// The per-encoding payload layouts prepareData dispatches to. Each returns the
// chunk buffers the emission loop turns into outputs, with the encoding used.

function opReturnPayload(data, encoding, magicWordBuffer){
    let chunksSize = 0
    let dataBufferArray = []
    chunksSize = OP_RETURN_SIZE - magicWordBuffer.length //Single OP_RETURN output: 80-byte limit minus 4-byte magic word = 76 bytes of payload

    // All supported chains (BTC, LTC, DOGE) inherit Bitcoin Core's
    // IsStandardTx rule that rejects any transaction with more than one
    // nulldata/OP_RETURN output as non-standard ("multi-op-return"). A split
    // payload builds a structurally valid PSBT that fails silently at broadcast
    // and burns the fee UTXOs. The auto-selection path avoids this by falling
    // back to P2SH; the explicit-encoding path must reject loudly here instead.
    //
    // The single-output 80-byte ceiling is enforced unconditionally.
    // singleOpReturnPolicy:false does not skip this throw and fall
    // through to a multi-chunk split loop instead: no shipped decoder
    // can reassemble a payload split across multiple OP_RETURN pushes
    // (it only ever reads a single OP_RETURN output), and no shipped
    // coin relays a multi-OP_RETURN transaction as standard, so that
    // path was a fee-burning, undecodable-transaction trap armed by one
    // config flag rather than a real opt-out. Fail-closed
    // unconditionally now, the same as when the flag is absent.
    if (data.length > chunksSize) {
        throw new RangeError(
            `OP_RETURN encoding requires compiled payload <= ${chunksSize} bytes; ` +
            `got ${data.length}. Use P2SH for larger payloads.`
        )
    }

    // data.length <= chunksSize is now guaranteed above, so the
    // payload always compiles to exactly one OP_RETURN chunk.
    dataBufferArray.push(Buffer.concat([magicWordBuffer,data]))

    return {"dataBufferArray":dataBufferArray, "encoding": encoding}
}

function scriptHashPayload(data, encoding, pubKey){
    let chunksSize = 0
    let dataBufferArray = []
    /* REDEEM SCRIPT (exactly as compiled below)
    <data_chunk>       // the on-wire data push (max chunksSize bytes)
    +
    OP_DROP            // 1 byte  - drops the data so it never gates the spend
    +
    OP_DUP             // 1 byte
    +
    OP_HASH160         // 1 byte
    +
    <hash160>          // 20-byte HASH160 of the caller key
                       //   (resolveCallerHash160(pubKey): base58 addr,
                       //   raw pubkey hex, or v0 bech32 P2WPKH all yield
                       //   the same HASH160(pubkey)), NOT a 33-byte pubkey
    +
    OP_EQUALVERIFY     // 1 byte
    +
    OP_CHECKSIG        // 1 byte
    //
    // The trailing five ops form an ordinary P2PKH gate; the data rides
    // in the leading push and is discarded at spend time by OP_DROP.
    // There is no n / OP_DEPTH / 0 / OP_EQUAL tail (that older sketch
    // never matched the compiled script).
    */

    chunksSize = (encoding == Encoding.P2SH?P2SH_SIZE:PW2SH_SIZE) - 44 // 44 is a conservative per-chunk overhead reservation that leaves headroom under the 520-byte consensus MAX_SCRIPT_ELEMENT_SIZE (P2SH_SIZE/PW2SH_SIZE) for the OP_DROP/OP_DUP/OP_HASH160/<hash160>/OP_EQUALVERIFY/OP_CHECKSIG trailer plus the leading data-push prefix. Each chunk becomes one P2SH/P2WSH output; the input spending it carries the data inside its redeem/witness script.

    let pubkeyFromBase58 = resolveCallerHash160(pubKey)

    let p2shChunks = sliceScriptHashChunks(data, chunksSize)

    for (const chunk of p2shChunks){
        let nextDataBuffer = bitcoin.script.compile([
            chunk,
            bitcoin.opcodes.OP_DROP,
            bitcoin.opcodes.OP_DUP,
            bitcoin.opcodes.OP_HASH160,
            pubkeyFromBase58,
            bitcoin.opcodes.OP_EQUALVERIFY,
            bitcoin.opcodes.OP_CHECKSIG,
        ])

        dataBufferArray.push(nextDataBuffer)
    }

    return {"dataBufferArray":dataBufferArray, "encoding": encoding}
}

function sliceScriptHashChunks(data, chunksSize){
    let i = 0
    let nextDataChunk = null
    // Slice the chunk boundaries first so a degenerate 1-byte final
    // chunk can be rebalanced before compile. bitcoin.script.compile
    // applies asMinimalOP: a lone data byte of 0x01-0x10 or 0x81
    // canonicalizes to a bare opcode, and the decoder's redeem-script
    // Buffer gate (XChainDecoder.js: !Buffer.isBuffer(decodedRedeemScript[0]))
    // then silently skips that output, corrupting reassembly of an
    // otherwise-valid multi-byte payload. Shifting one byte from the
    // penultimate chunk keeps every chunk >= 2 bytes; the decoder
    // reassembles by concatenation so moving a byte across the
    // boundary is transparent end-to-end.
    let p2shChunks = []
    i = 0
    while (i < data.length){
        nextDataChunk = data.subarray(i,i+chunksSize)
        p2shChunks.push(nextDataChunk)
        i = i + nextDataChunk.length
    }
    if (p2shChunks.length >= 2){
        let last = p2shChunks[p2shChunks.length - 1]
        if (last.length === 1 && ((last[0] >= 0x01 && last[0] <= 0x10) || last[0] === 0x81)){
            // Repartition the final two chunks: penultimate drops its
            // last byte, final grows to 2 bytes. Both are re-sliced
            // from `data` so the concatenation is byte-identical.
            let prevStart = data.length - 1 - p2shChunks[p2shChunks.length - 2].length
            p2shChunks[p2shChunks.length - 2] = data.subarray(prevStart, data.length - 2)
            p2shChunks[p2shChunks.length - 1] = data.subarray(data.length - 2)
        }
    }
    return p2shChunks
}

function multisignPayload(data, encoding, magicWordBuffer){
    let chunksSize = 0
    let dataBufferArray = []
    let i = 0
    let nextDataChunk = null
    chunksSize = MULTISIGN_SIZE
        - magicWordBuffer.length
        - 1 //1 byte for the OP_CHECKMULTISIG
        - 1 //1 byte for the m signatures to pop
        - 1 //1 byte for the n addresses to pop
        - 1 //1 byte for the first address length
        - 1 //1 byte for the second address length

    // Each MULTISIGN output carries its data across two 32-byte
    // pubkey halves (64 data bytes total). A full chunk is already
    // magic(4) + 60 = 64 bytes, but the final chunk is shorter.
    // Zero-pad every chunk up to the full 64-byte slot so BOTH
    // pubkey halves are always complete 32-byte values. Without
    // this, a short final chunk leaves the second half empty (or
    // near-empty); dataToPubkey() then produces an all-zero /
    // low-entropy EC point that bitcoinjs-lib rejects as not a
    // valid point. The reader strips this trailing pad using the
    // payload's own self-describing compiled-script length, so the
    // padding is invisible end-to-end.
    let multisignSlotSize = 64

    i = 0
    while (i < data.length){
        nextDataChunk = data.subarray(i,i+chunksSize)
        let nextChunk = Buffer.concat([magicWordBuffer,nextDataChunk])
        if (nextChunk.length < multisignSlotSize){
            nextChunk = Buffer.concat([nextChunk, Buffer.alloc(multisignSlotSize - nextChunk.length, 0)])
        }
        dataBufferArray.push(nextChunk)
        i = i + nextDataChunk.length
    }

    return {"dataBufferArray":dataBufferArray, "encoding": encoding}
}

function envelopePayload(data, encoding, compressedPubKey, magicWordBuffer){
    /* TAPROOT ENVELOPE LEAF (grammar frozen at review)
    OP_FALSE OP_IF
      <"XCHN">            // 4-byte magic, CLEARTEXT (same constant as every lane)
      <0x00>              // format byte v0, cleartext
      <payload push 1..n> // raw payload, 520-byte elements, in order
    OP_ENDIF
    <internal pubkey> OP_CHECKSIG
    //
    // The payload is the compiled action stream (`data` here: the
    // action-string push plus the rawData push), byte-identical to
    // what the chunk lanes carry, with the magic excluded because
    // the envelope header already carries it. Raw by design: the
    // shipped large-payload (P2WSH) precedent is unobfuscated, and
    // keying on the commit txid is circular by construction.
    */
    // The leaf tail and the key-path cancel both need the caller's
    // real pubkey; `pubKey` may be a bare address, so the explicit
    // compressedPubKey is required, mirroring MULTISIGN.
    if (compressedPubKey == null) {
        throw new TypeError('compressedPubKey is required for TAPROOT encoding (it becomes the envelope internal key)')
    }
    if (typeof compressedPubKey !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(compressedPubKey)) {
        throw new TypeError('compressedPubKey must be a 66-character hex string starting with 02 or 03')
    }
    const internalPubkey = Buffer.from(compressedPubKey, 'hex').subarray(1)
    let envelopeChunks = sliceEnvelopeChunks(data)

    const envelopeScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_0, // OP_FALSE
        bitcoin.opcodes.OP_IF,
        magicWordBuffer,
        Buffer.from([TAPROOT_ENVELOPE_FORMAT_V0]),
        ...envelopeChunks,
        bitcoin.opcodes.OP_ENDIF,
        internalPubkey,
        bitcoin.opcodes.OP_CHECKSIG,
    ])

    // dataBufferArray carries exactly ONE element: the whole
    // envelope tapscript. The emission loop turns it into one
    // commit output; there is no per-chunk output fan-out.
    return {"dataBufferArray":[envelopeScript], "encoding": encoding, "internalPubkey": internalPubkey}
}

function sliceEnvelopeChunks(data){
    let chunksSize = 0
    let i = 0
    let nextDataChunk = null
    chunksSize = TAPROOT_ENVELOPE_CHUNK_SIZE
    let envelopeChunks = []
    i = 0
    while (i < data.length){
        nextDataChunk = data.subarray(i, i + chunksSize)
        envelopeChunks.push(nextDataChunk)
        i = i + nextDataChunk.length
    }
    // Same degenerate-final-chunk rebalance as the P2SH/P2WSH lane:
    // bitcoin.script.compile canonicalizes a lone 0x01-0x10/0x81 byte
    // to a bare opcode (asMinimalOP), which would corrupt the
    // concatenation the decoder reassembles. Shift one byte across
    // the final boundary so every push stays >= 2 bytes. (A 1-byte
    // TOTAL payload cannot occur: the compiled stream always leads
    // with a push opcode, so any non-empty payload is >= 2 bytes.)
    if (envelopeChunks.length >= 2){
        let last = envelopeChunks[envelopeChunks.length - 1]
        if (last.length === 1 && ((last[0] >= 0x01 && last[0] <= 0x10) || last[0] === 0x81)){
            let prevStart = data.length - 1 - envelopeChunks[envelopeChunks.length - 2].length
            envelopeChunks[envelopeChunks.length - 2] = data.subarray(prevStart, data.length - 2)
            envelopeChunks[envelopeChunks.length - 1] = data.subarray(data.length - 2)
        }
    }
    return envelopeChunks
}

module.exports = { opReturnPayload, scriptHashPayload, multisignPayload, envelopePayload }
