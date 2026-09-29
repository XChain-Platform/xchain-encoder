// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Shared builders for the prev-out value check suite (input_selection.js
// assertPrevOutValueMatches). A legacy sighash does not commit to input
// amounts, so a stated utxos[].value below the real output would sign and pay
// the gap to miners; these files pin the build's refusal of any disagreement.

const factory = require('../../../../integration/helpers/utxoFactory')
const actions = require('../../../../integration/helpers/actionFactory')

const DOGE = 'dogecoin-regtest'
const LTC = 'litecoin-regtest'
const DOGE_ADDR = factory.getTestAddress(DOGE)
const LTC_ADDR = factory.getTestAddress(LTC)
const FEE = 10000

// Caller-supplied build on DOGE, where every input is legacy.
function buildDoge (encoder, utxos) {
  return encoder.createTransaction(
    utxos, DOGE_ADDR, null,
    actions.makeSend().data, null, FEE, false, null, DOGE_ADDR,
    null, null, null, true, 0.00001
  )
}

// Segwit build on LTC; attachPrevTx is the hardware-signer opt-in.
function buildLtc (encoder, utxos, attachPrevTx) {
  return encoder.createTransaction(
    utxos, LTC_ADDR, null,
    actions.makeSend().data, null, FEE, false, null, LTC_ADDR,
    null, null, null, true, 0.00001, null, null, attachPrevTx
  )
}

// Prev txs that pay `onChain` where each UTXO states something else.
function attachOnChainValues (encoder, utxos, onChain, network) {
  factory.attachPrevTxs(encoder, utxos.map((u) => Object.assign({}, u, { value: onChain })), network)
}

function sumOutputs (psbt) {
  return psbt.txOutputs.reduce((sum, o) => sum + BigInt(o.value), 0n)
}

// The fee a DOGE build pays: the request, lifted to the chain dust floor it sits under.
function paidFee (encoder) {
  return BigInt(Math.max(FEE, Number(encoder.dustAmount)))
}

module.exports = {
  factory,
  DOGE,
  LTC,
  DOGE_ADDR,
  buildDoge,
  buildLtc,
  attachOnChainValues,
  sumOutputs,
  paidFee
}
