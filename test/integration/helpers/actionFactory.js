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
 * ACTION payload factory for integration tests.
 *
 * Each function returns a { data, rawData } object matching the parameters
 * expected by XChainEncoder.createTransaction().
 *
 * ACTION format: ACTION|VERSION|FIELD1|FIELD2|...
 * BATCH format:  ACTION1;ACTION2;ACTION3
 */

const ADDR_BTC = '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev'
const ADDR_BTC_2 = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9'

function makeSend (tick = 'JDOG', amount = '1', dest = ADDR_BTC, memo = null) {
  const parts = ['SEND', '0', tick, amount, dest]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeMultiSendV1 (tick = 'BRRR', transfers = [{ amount: '5', dest: ADDR_BTC }, { amount: '1', dest: ADDR_BTC_2 }]) {
  const parts = ['SEND', '1', tick]
  for (const t of transfers) {
    parts.push(t.amount, t.dest)
  }
  return { data: parts.join('|'), rawData: null }
}

function makeMultiSendV2 (transfers = [{ tick: 'BRRR', amount: '5', dest: ADDR_BTC }, { tick: 'TEST', amount: '1', dest: ADDR_BTC_2 }], memo = null) {
  const parts = ['SEND', '2']
  for (const t of transfers) {
    parts.push(t.tick, t.amount, t.dest)
  }
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeMultiSendV3 (transfers = [{ tick: 'BRRR', amount: '5', dest: ADDR_BTC, memo: 'hi' }, { tick: 'TEST', amount: '1', dest: ADDR_BTC_2, memo: 'bye' }]) {
  const parts = ['SEND', '3']
  for (const t of transfers) {
    parts.push(t.tick, t.amount, t.dest, t.memo || '')
  }
  return { data: parts.join('|'), rawData: null }
}

function makeIssueMinimal (tick = 'X') {
  return { data: `ISSUE|0|${tick}`, rawData: null }
}

function makeIssueFull (tick = 'TEST', opts = {}) {
  const fields = [
    'ISSUE', '0', tick,
    opts.maxSupply || '1000',
    opts.maxMint || '1',
    opts.decimals || '8',
    opts.description || 'A test token description',
    opts.mintSupply || '100',
    opts.transfer || ADDR_BTC,
    opts.transferSupply || ADDR_BTC,
    opts.lockMaxSupply || '1',
    opts.lockMaxMint || '1',
    opts.lockDescription || '1',
    opts.lockRug || '0',
    opts.lockSleep || '1',
    opts.lockCallback || '1',
    opts.callbackBlock || '0',
    opts.callbackTick || '',
    opts.callbackAmount || '',
    opts.allowList || '0',
    opts.blockList || '0',
    opts.mintAddressMax || '0',
    opts.mintStartBlock || '0',
    opts.mintStopBlock || '0',
    opts.lockMint || '0',
    opts.lockMintSupply || '0',
    opts.memo || 'integration test'
  ]
  return { data: fields.join('|'), rawData: null }
}

function makeIssueEditDescription (tick = 'TEST', description = 'Updated description', memo = null) {
  const parts = ['ISSUE', '1', tick, description]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeMint (tick = 'JDOG', amount = '100', memo = null) {
  const parts = ['MINT', '0', tick, amount]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeDestroy (tick = 'JDOG', amount = '50', memo = null) {
  const parts = ['DESTROY', '0', tick, amount]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeCallback (tick = 'JDOG', memo = null) {
  const parts = ['CALLBACK', '0', tick]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeSleep (tick = 'JDOG', resumeBlock = '900000', memo = null) {
  const parts = ['SLEEP', '0', tick, resumeBlock]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeSweep (dest = ADDR_BTC, memo = null) {
  const parts = ['SWEEP', '0', dest]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeAirdrop (tick = 'JDOG', listIndex = '100', amount = '10', memo = null) {
  const parts = ['AIRDROP', '0', tick, listIndex, amount]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeDividend (tick = 'JDOG', dividendTick = 'BRRR', amount = '1000', memo = null) {
  const parts = ['DIVIDEND', '0', tick, dividendTick, amount]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeOrder (type = 'BUY', giveTick = 'JDOG', giveAmount = '100', getTick = 'BRRR', getAmount = '50', expiration = '0') {
  return {
    data: `ORDER|0|${type}|${giveTick}|${giveAmount}|${getTick}|${getAmount}|${expiration}`,
    rawData: null
  }
}

function makeCoinpay (orderMatchIndex = '42') {
  return { data: `COINPAY|0|${orderMatchIndex}`, rawData: null }
}

function makeDispenser (tick = 'JDOG', giveAmount = '100', perAmount = '10', status = '1', dest = ADDR_BTC) {
  return {
    data: `DISPENSER|0|${tick}|${giveAmount}|${perAmount}|${status}|${dest}|0|0`,
    rawData: null
  }
}

function makeSwap (tick = 'JDOG', amount = '100', destChain = 'LTC', destTick = 'LDOG', destAmount = '200') {
  return {
    data: `SWAP|0|${tick}|${amount}|${destChain}|${destTick}|${destAmount}`,
    rawData: null
  }
}

function makeBroadcast (text = 'Hello XChain World') {
  return { data: `BROADCAST|0|${text}`, rawData: null }
}

function makeBroadcastLong () {
  const longText = 'This is a very long broadcast message that will exceed the OP_RETURN limit. '.repeat(3)
  return { data: `BROADCAST|0|${longText}`, rawData: null }
}

function makeMessage (dest = ADDR_BTC, text = 'Hello') {
  return { data: `MESSAGE|0|${dest}|${text}`, rawData: null }
}

function makeFile (name = 'test.json', mime = 'application/json', content = null) {
  const fileContent = content || Buffer.alloc(600, 0x41).toString('utf8') // 600 bytes
  return { data: `FILE|0|${name}|${mime}|${fileContent}`, rawData: null }
}

function makeFileLarge () {
  // >520 bytes to force P2WSH
  const content = Buffer.alloc(1000, 0x42).toString('utf8')
  return { data: `FILE|0|bigfile.bin|application/octet-stream|${content}`, rawData: null }
}

function makeAddress (requireMemo = '1', memo = null) {
  const parts = ['ADDRESS', '0', requireMemo]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeBatch (actions) {
  // actions is an array of { data } objects from other factory functions
  const combined = actions.map(a => a.data).join(';')
  return { data: combined, rawData: null }
}

function makeLink (actionIndex = '42', linkedActionIndex = '99', memo = null) {
  const parts = ['LINK', '0', actionIndex, linkedActionIndex]
  if (memo) parts.push(memo)
  return { data: parts.join('|'), rawData: null }
}

function makeList (items = [ADDR_BTC, ADDR_BTC_2]) {
  return { data: `LIST|0|${items.join(',')}`, rawData: null }
}

/**
 * Generate an ACTION string of exactly the given byte length.
 * Uses SEND with padding in the memo field.
 */
function makeActionOfSize (targetBytes) {
  const prefix = 'SEND|0|X|1|' + ADDR_BTC + '|'
  const prefixLen = Buffer.byteLength(prefix, 'utf8')
  if (targetBytes <= prefixLen) {
    // Fall back to raw padding
    return { data: 'X'.repeat(targetBytes), rawData: null }
  }
  const padding = 'P'.repeat(targetBytes - prefixLen)
  return { data: prefix + padding, rawData: null }
}

/**
 * SEND using TICK_ID reference with caret prefix.
 */
function makeSendByTickId (tickId = '1234', amount = '100', dest = ADDR_BTC) {
  return { data: `SEND|0|^${tickId}|${amount}|${dest}`, rawData: null }
}

/**
 * ISSUE with special characters in TICK name.
 */
function makeIssueSpecialChars (tick = 'J-DOG_#1') {
  return { data: `ISSUE|0|${tick}`, rawData: null }
}

module.exports = {
  ADDR_BTC,
  ADDR_BTC_2,
  // Token lifecycle
  makeSend,
  makeMultiSendV1,
  makeMultiSendV2,
  makeMultiSendV3,
  makeIssueMinimal,
  makeIssueFull,
  makeIssueEditDescription,
  makeMint,
  makeDestroy,
  makeCallback,
  makeSleep,
  // Transfers
  makeSweep,
  makeAirdrop,
  makeDividend,
  // DEX
  makeOrder,
  makeCoinpay,
  makeDispenser,
  makeSwap,
  // Data and communication
  makeBroadcast,
  makeBroadcastLong,
  makeMessage,
  makeFile,
  makeFileLarge,
  // Utility
  makeAddress,
  makeBatch,
  makeLink,
  makeList,
  // Edge cases
  makeActionOfSize,
  makeSendByTickId,
  makeIssueSpecialChars
}
