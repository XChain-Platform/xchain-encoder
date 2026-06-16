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
 * Shared deobfuscation utility for integration tests.
 *
 * The encoder uses AES-128-CTR with the first input's TXID as key material:
 *   key = txid.substr(0, 16)
 *   iv  = txid.substr(16, 16)
 *
 * This module provides helpers to reverse that process and extract the
 * original ACTION payload from PSBT outputs.
 */

const crypto = require('crypto')
const bitcoin = require('bitcoinjs-lib')

const MAGIC_WORD = 'XCHN'

/**
 * Deobfuscate data using AES-128-CTR with TXID-derived key/IV.
 * Mirrors XChainEncoder.obfuscate() in reverse.
 */
function deobfuscate (data, txid) {
  const key = txid.substr(0, 16)
  const iv = txid.substr(16, 16)
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/**
 * Extract and deobfuscate the ACTION payload from an OP_RETURN PSBT output.
 *
 * @param {object} psbtResult - The { psbt, encoding } returned by createTransaction()
 * @param {string} txid - The first input's TXID (used as obfuscation key)
 * @returns {{ magic: string, dataBuffer: Buffer, chunks: Buffer[] }}
 */
function extractOpReturnPayload (psbtResult, txid) {
  const outputs = psbtResult.psbt.txOutputs
  const opReturnOutputs = outputs.filter(o => o.value === 0)

  const chunks = []
  for (const output of opReturnOutputs) {
    // OP_RETURN script: 0x6a <push> <data>
    const decompiled = bitcoin.script.decompile(output.script)
    // decompiled[0] = OP_RETURN, decompiled[1] = data buffer
    const obfuscatedData = decompiled[1]
    const decrypted = deobfuscate(obfuscatedData, txid)
    chunks.push(decrypted)
  }

  // Each chunk starts with XCHN magic; strip it and concatenate the data portions
  const dataPortions = chunks.map(c => c.subarray(4))
  const reassembled = Buffer.concat(dataPortions)
  const magic = chunks[0].subarray(0, 4).toString('utf8')

  return { magic, dataBuffer: reassembled, chunks }
}

/**
 * Extract and deobfuscate the ACTION payload from MULTISIGN PSBT outputs.
 *
 * MULTISIGN embeds data in two fake pubkeys of a 1-of-3 multisig output.
 * Each pubkey is 33 bytes: 0x02 prefix + 32 bytes of obfuscated data.
 * The two 32-byte halves are concatenated, trailing zero-padding stripped,
 * then deobfuscated.
 *
 * @param {object} psbtResult - The { psbt, encoding } returned by createTransaction()
 * @param {string} txid - The first input's TXID
 * @param {number} dustAmount - The dust value used for multisig outputs
 * @returns {{ magic: string, dataBuffer: Buffer, chunks: Buffer[] }}
 */
function extractMultisignPayload (psbtResult, txid, dustAmount) {
  const outputs = psbtResult.psbt.txOutputs
  const msOutputs = outputs.filter(o => o.value === dustAmount)

  const chunks = []
  for (const output of msOutputs) {
    const decompiled = bitcoin.script.decompile(output.script)
    // OP_1 <pubkey1> <pubkey2> <pubkey3> OP_3 OP_CHECKMULTISIG
    const pubkey1 = decompiled[1].subarray(1) // strip 0x02
    const pubkey2 = decompiled[2].subarray(1) // strip 0x02

    let dataConcat = Buffer.concat([pubkey1, pubkey2])

    // Strip trailing zero padding
    for (let i = dataConcat.length - 1; i >= 0; i--) {
      if (dataConcat[i] !== 0) {
        dataConcat = dataConcat.subarray(0, i + 1)
        break
      }
    }

    const decrypted = deobfuscate(dataConcat, txid)
    chunks.push(decrypted)
  }

  const dataPortions = chunks.map(c => c.subarray(4))
  const reassembled = Buffer.concat(dataPortions)
  const magic = chunks[0].subarray(0, 4).toString('utf8')

  return { magic, dataBuffer: reassembled, chunks }
}

/**
 * Decompile a data buffer that was created via bitcoin.script.compile([dataBuffer])
 * or bitcoin.script.compile([dataBuffer, rawDataBuffer]).
 *
 * Returns the decompiled array of buffers/strings.
 */
function decompilePayload (dataBuffer) {
  return bitcoin.script.decompile(dataBuffer)
}

module.exports = {
  deobfuscate,
  extractOpReturnPayload,
  extractMultisignPayload,
  decompilePayload,
  MAGIC_WORD
}
