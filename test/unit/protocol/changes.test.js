// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { ENVELOPE_RECOGNITION_ACTIVATION } = require('../../../src/protocol/changes')
const CryptoNetworks = require('../../../src/build/crypto_networks')

describe('protocol changes', () => {
  it('is the same activation map re-exported by CryptoNetworks', () => {
    assert.strictEqual(
      ENVELOPE_RECOGNITION_ACTIVATION,
      CryptoNetworks.ENVELOPE_RECOGNITION_ACTIVATION
    )
  })
})
