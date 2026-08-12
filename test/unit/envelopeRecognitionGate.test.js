/*********************************************************************
 * Unit: Taproot envelope recognition gate
 *
 * Segwit support alone was the whole TAPROOT gate, and it is not enough.
 * Envelope recognition activates at a per-network height (spec §7); below it
 * every decoder on the fleet ignores the reveal, so a build here would hand the
 * caller a valid, broadcastable, correctly signed commit/reveal pair for an
 * action that will never exist, and they pay a real miner fee for it. The
 * decoder's refusal is silent and correct, so this is the only layer that can
 * catch it.
 *
 * Two properties are pinned:
 *   1. the gate itself refuses below the height, allows at/above, and
 *      fail-closes when the tip is unknowable;
 *   2. the encoder's per-network heights stay byte-equal to xchain-decoder's
 *      ENVELOPE_RECOGNITION_ACTIVATION, which is the consensus copy. A drift
 *      here is a fleet fork, not a config nit.
 **********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const XChainEncoder  = require('../../src/XChainEncoder');
const CryptoNetworks = require('../../src/CryptoNetworks');

// The gate reads only the resolved recognition height and connector.getBlockCount,
// so a network KEY plus a stub connector is the whole surface; building a real
// encoder (and a real node) is unnecessary.
function gateWithKey(networkKey, tip) {
    const ctx = {
        networkKey,
        connector: tip === 'no-method' ? {} : { getBlockCount: async () => tip },
    };
    return XChainEncoder.prototype.assertEnvelopeRecognized.call(ctx);
}
// Read from the shipped map, not a literal: every boundary property below holds
// at WHATEVER height is armed, and these heights have already moved once
// (961000 -> 960850 on 2026-08-02). The literal pin lives in the last test, on
// purpose, so a surprise change trips exactly one assertion instead of ten.
const BTC_MAINNET_HEIGHT = CryptoNetworks.getEnvelopeRecognitionHeight('bitcoin-mainnet');
function gateWith(height, tip) {
    // map the height under test onto a real network key carrying it
    const key = height === 0 ? 'bitcoin-regtest'
              : height === BTC_MAINNET_HEIGHT ? 'bitcoin-mainnet'
              : 'dogecoin-mainnet';               // the null (never) case
    return gateWithKey(key, tip);
}
async function refuses(height, tip, codeOrType) {
    try { await gateWith(height, tip); }
    catch (e) {
        if (codeOrType === 'TypeError') return assert.ok(e instanceof TypeError, 'expected TypeError, got ' + e);
        return assert.strictEqual(e.xchainCode, codeOrType, 'wrong code: ' + e.message);
    }
    assert.fail(`expected a refusal for height=${height} tip=${tip}`);
}

describe('assertEnvelopeRecognized()', function () {
    it('allows a genesis-active network without consulting the node at all', async function () {
        // regtest/testnet are height 0; asking the node would be a pointless round trip
        await gateWith(0, 'no-method');
    });

    it('allows at the activation height and above', async function () {
        await gateWith(BTC_MAINNET_HEIGHT, BTC_MAINNET_HEIGHT);
        await gateWith(BTC_MAINNET_HEIGHT, BTC_MAINNET_HEIGHT + 1);
        await gateWith(BTC_MAINNET_HEIGHT, 9999999);
    });

    it('REFUSES below the activation height, naming the shortfall', async function () {
        const tip = BTC_MAINNET_HEIGHT - 399;
        try { await gateWith(BTC_MAINNET_HEIGHT, tip); assert.fail('should have refused'); }
        catch (e) {
            assert.strictEqual(e.xchainCode, 'ENVELOPE_NOT_YET_ACTIVE');
            assert.strictEqual(e.operational, true);
            assert.deepStrictEqual(e.details,
                { recognitionHeight: BTC_MAINNET_HEIGHT, chainTip: tip, blocksRemaining: 399 });
            assert.ok(new RegExp(BTC_MAINNET_HEIGHT).test(e.message) && new RegExp(tip).test(e.message),
                      'message must name both heights: ' + e.message);
        }
    });

    it('refuses one block below and allows exactly at the height (boundary is inclusive)', async function () {
        await refuses(BTC_MAINNET_HEIGHT, BTC_MAINNET_HEIGHT - 1, 'ENVELOPE_NOT_YET_ACTIVE');
        await gateWith(BTC_MAINNET_HEIGHT, BTC_MAINNET_HEIGHT);
    });

    it('FAIL-CLOSES when the tip is unknowable, rather than assuming', async function () {
        // a node that cannot answer must not be read as "probably fine"; the cost
        // of guessing wrong is the caller's money
        await refuses(BTC_MAINNET_HEIGHT, null, 'ENVELOPE_RECOGNITION_UNKNOWN');
        await refuses(BTC_MAINNET_HEIGHT, undefined, 'ENVELOPE_RECOGNITION_UNKNOWN');
        await refuses(BTC_MAINNET_HEIGHT, NaN, 'ENVELOPE_RECOGNITION_UNKNOWN');
        await refuses(BTC_MAINNET_HEIGHT, 'not-a-height', 'ENVELOPE_RECOGNITION_UNKNOWN');
        await refuses(BTC_MAINNET_HEIGHT, 'no-method', 'ENVELOPE_RECOGNITION_UNKNOWN');
    });

    it('refuses a network that never recognizes envelopes (null: DOGE, no segwit)', async function () {
        await refuses(null, 999999, 'TypeError');
    });

    it('refuses an unparseable network key rather than treating it as allowed', async function () {
        try { await gateWithKey('no-such-network', 999999); assert.fail('should have refused'); }
        catch (e) { assert.ok(e instanceof TypeError, 'expected TypeError, got ' + e); }
    });

    it('resolves the real shipped heights per network', function () {
        assert.strictEqual(CryptoNetworks.getEnvelopeRecognitionHeight('bitcoin-mainnet'), 960850);
        assert.strictEqual(CryptoNetworks.getEnvelopeRecognitionHeight('litecoin-mainnet'), 3153500);
        assert.strictEqual(CryptoNetworks.getEnvelopeRecognitionHeight('bitcoin-testnet'), 0);
        assert.strictEqual(CryptoNetworks.getEnvelopeRecognitionHeight('bitcoin-regtest'), 0);
        assert.strictEqual(CryptoNetworks.getEnvelopeRecognitionHeight('dogecoin-mainnet'), null);
    });
});

describe('encoder activation heights are byte-equal to the decoder consensus copy', function () {
    const DECODER = process.env.XCHAIN_DECODER_DIR ||
        path.join(__dirname, '..', '..', '..', 'xchain-decoder');
    const DECODER_CONSTANTS = path.join(DECODER, 'src', 'protocol', 'constants.js');

    before(function () {
        if (!fs.existsSync(DECODER_CONSTANTS)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
                throw new Error('xchain-decoder sibling not found at ' + DECODER_CONSTANTS +
                                ' but XCHAIN_REQUIRE_SIBLINGS=1');
            }
            this.skip();
        }
    });

    it('the whole table is deep-equal to the decoder consensus copy', function () {
        const { ENVELOPE_RECOGNITION_ACTIVATION } = require(DECODER_CONSTANTS);
        assert.deepStrictEqual(CryptoNetworks.ENVELOPE_RECOGNITION_ACTIVATION,
                               ENVELOPE_RECOGNITION_ACTIVATION,
                               'encoder/decoder activation drift forks the fleet or silently burns a fee');
    });

    it('every network key the encoder can parse resolves to the decoder height', function () {
        const { ENVELOPE_RECOGNITION_ACTIVATION } = require(DECODER_CONSTANTS);
        const NAMES = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' };
        for (const tick of Object.keys(ENVELOPE_RECOGNITION_ACTIVATION)) {
            for (const net of ['mainnet', 'testnet', 'regtest']) {
                assert.strictEqual(
                    CryptoNetworks.getEnvelopeRecognitionHeight(`${NAMES[tick]}-${net}`),
                    ENVELOPE_RECOGNITION_ACTIVATION[tick][net], `${tick}/${net}`);
            }
        }
    });
});
