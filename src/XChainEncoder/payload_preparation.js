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
const crypto = require('crypto');
const CryptoNetworks = require('../build/crypto_networks')
const { MAX_COMPILED_ACTION_DATA_LENGTH, ENVELOPE_MAX_PAYLOAD } = require('../common/validator')
const { OP_RETURN_SIZE, P2SH_SIZE, PW2SH_SIZE, MULTISIGN_SIZE, MAGIC_WORD, TAPROOT_ENVELOPE_CHUNK_SIZE, TAPROOT_ENVELOPE_FORMAT_V0, Encoding } = require('./constants.js')
const { resolveCallerHash160 } = require('./request_resolution.js')
const { opReturnPayload, scriptHashPayload, multisignPayload, envelopePayload } = require('./payload_encodings.js')

module.exports = {
    isSegwitUTXO(utxo) {
        try {
            const script = bitcoin.script.decompile(Buffer.from(utxo.scriptPubKey, 'hex'));
            // A witness program is exactly [version opcode][2..40 byte push]: OP_0
            // (0x00) for v0 (P2WPKH/P2WSH), OP_1..OP_16 (0x51..0x60) for v1..v16.
            // Taproot is v1, so the old v0-only check (script[0] === 0x00) treated
            // P2TR UTXOs as legacy and set nonWitnessUtxo instead of witnessUtxo -
            // but Taproot signing (and the MuSig2 co-signer) require witnessUtxo.
            if (!script || script.length !== 2 || !Buffer.isBuffer(script[1])) return false;
            const version = script[0];
            const isWitnessVersion = version === bitcoin.opcodes.OP_0 ||
                (version >= bitcoin.opcodes.OP_1 && version <= bitcoin.opcodes.OP_16);
            return isWitnessVersion && script[1].length >= 2 && script[1].length <= 40;
        } catch (error) {
            return false;
        }
    },

    prepareData(data, encoding, pubKey, compressedPubKey){
        let magicWordBuffer = Buffer.from(MAGIC_WORD,'utf8')

        if (!encoding){
            if (data.length + magicWordBuffer.length <= OP_RETURN_SIZE) {
                encoding = Encoding.OP_RETURN
            } else {
                encoding = Encoding.P2SH
            }
        }
        switch (encoding){
            case Encoding.OP_RETURN:
                return opReturnPayload(data, encoding, magicWordBuffer)
            case Encoding.P2SH:
            case Encoding.P2WSH:
                return scriptHashPayload(data, encoding, pubKey)
            case Encoding.MULTISIGN:
                return multisignPayload(data, encoding, magicWordBuffer)
            case Encoding.TAPROOT: {
                return envelopePayload(data, encoding, compressedPubKey, magicWordBuffer)
            }
            default:
                throw new TypeError(`Unknown encoding: "${encoding}". Valid values: OP_RETURN, P2SH, MULTISIGN, P2WSH, TAPROOT`)
        }
    },

    async obfuscate(data, key){
        var cipherKey = key.substr(0,16)
        var iv = key.substr(16,16)

        var cipher = crypto.createCipheriv('aes-128-ctr', cipherKey, iv);
        var encryptedData = cipher.update(data)
        encryptedData = Buffer.concat([encryptedData,cipher.final()])
        return encryptedData
    },

    async dataToPubkey(data){
        let bufferArray = [Buffer.from("02","hex"),data]
        let bufferFill = null
        if (data.length < 32){
            bufferFill = Buffer.allocUnsafe(32 - data.length)
            bufferFill.fill("00", 0, bufferFill.length, "hex")
            bufferArray.push(bufferFill)
        }

        return Buffer.concat(bufferArray)
    },

    /**
     * Refuse to build a Taproot envelope that decoders would ignore.
     *
     * Envelope recognition activates at a per-network height. Below it every decoder
     * treats the reveal as an ordinary P2TR spend, so the caller would pay a real
     * miner fee, write a real payload on chain, and own an action that does not
     * exist. That refusal is silent and correct by design and nothing downstream can
     * detect the loss, which is exactly why the check has to live here. Fail-closed
     * on an unknown height too: a node that cannot answer getblockcount leaves us
     * unable to prove recognition is active, and guessing wrong costs the caller
     * real money.
     *
     * `null` means the network never recognizes envelopes (DOGE: no segwit). That is
     * already refused by the supportsSegwit gate; this repeats it as a safety net for
     * any future non-segwit chain whose definition is added without one.
     */
    async assertEnvelopeRecognized(){
        const height = CryptoNetworks.getEnvelopeRecognitionHeight(this.networkKey)
        if (height === null || height === undefined) {
            throw new TypeError('TAPROOT encoding is not recognized on this network; ' +
                'no envelope recognition height is defined for it')
        }
        if (height === 0) return                    // genesis-active (testnet/regtest)

        const tip = this.connector && typeof this.connector.getBlockCount === 'function'
            ? await this.connector.getBlockCount()
            : null
        if (!Number.isFinite(tip)) {
            const e = new Error('Cannot confirm Taproot envelope recognition is active on this network ' +
                `(recognition height ${height}); the node did not return a chain height. Refusing to build ` +
                'an envelope that decoders may ignore.')
            e.operational = true
            e.xchainCode = 'ENVELOPE_RECOGNITION_UNKNOWN'
            throw e
        }
        if (tip < height) {
            const e = new Error(`Taproot envelope recognition is not active on this network until block ${height} ` +
                `(chain tip ${tip}, ${height - tip} block(s) to go). An envelope broadcast now would cost a real ` +
                'fee and be ignored by every decoder, so it is refused. Use P2WSH until the activation height.')
            e.operational = true
            e.xchainCode = 'ENVELOPE_NOT_YET_ACTIVE'
            e.details = { recognitionHeight: height, chainTip: tip, blocksRemaining: height - tip }
            throw e
        }
    },

    // Public entry point. It owns the per-call reservation ledger: every outpoint
    // the build claims is recorded there, and if the build throws for ANY reason
    // (INPUT_SELECTION_RACE, INSUFFICIENT_FUNDS, a fee-cap RangeError, an upstream
    // node error) those claims are handed back immediately instead of squatting
    // until RESERVATION_TTL_MS. Without that, the retry an INPUT_SELECTION_RACE
    // error explicitly asks for hit its OWN dead reservations and came back
    // INSUFFICIENT_FUNDS for up to five minutes. The release is ownership-stamped
    // so a concurrent call's entries are never dropped; see
    // releaseCallReservations. The success path keeps its reservations on purpose:
    // the caller is about to sign and broadcast those inputs.
    // A successful build's kept claims come back as a `reservation` receipt on the
    // result, which the caller hands to releaseReservation the moment it knows it
    // will not broadcast; see mintReservationTicket.
    async createTransaction(...args){
        const callReservations = []
        let result
        try {
            result = await this._buildTransaction(callReservations, ...args)
        } catch (err) {
            this.releaseCallReservations(callReservations)
            throw err
        }
        const reservation = this.mintReservationTicket(callReservations, Date.now())
        if (reservation && result && typeof result === 'object') result.reservation = reservation
        return result
    },
}
