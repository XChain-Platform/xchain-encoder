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
 * Validator wire actions: the name and format set the mainnet launch gate
 * admits before launch.
 *
 * Consensus skips every pre-launch mainnet transaction that is not a
 * validator wire action or from a pinned seed source, so the encoder's
 * prelaunch refusal must admit exactly this set: a wider set lets a caller
 * pay a fee for an action the indexer drops, and a narrower one refuses the
 * hub's own oracle and anchor publishes. The set, the name and format reading
 * and the verdict are pinned to the indexer's copy (src/consensus/gates/
 * validator_wire_actions.js) by test/unit/protocol/
 * validator_wire_actions_conformance.test.js.
 *
 ********************************************************************/

'use strict';

// ATTEST batch head and continuation formats, value-pinned to the indexer's attest batch wire constants.
const ATTEST_BATCH_HEAD_VERSION = 5;
const ATTEST_BATCH_CONTINUATION_VERSION = 6;

// Largest format number the dispatcher reads; anything larger names no format.
const MAX_FORMAT = 255;

// Hub-broadcast wire formats by action name. PRICE format 1 is the user oracle sharing the name, so it is absent.
const VALIDATOR_WIRE_FORMATS = Object.freeze({
    ANCHOR: Object.freeze([0, 1, 2, 3]),
    PRICE: Object.freeze([0]),
    NODEPROOF: Object.freeze([0]),
    ROLLCALL: Object.freeze([0, 1]),
    ATTEST: Object.freeze([1, 3, 4, ATTEST_BATCH_HEAD_VERSION, ATTEST_BATCH_CONTINUATION_VERSION])
});

// Format of the second field, or null when it names no format; a missing or empty field means 0.
function parseFormat(field) {
    if (field === undefined)
        return 0;
    const text = field.trim().replace(/"|'/g, '');
    if (text === '')
        return 0;
    // Refuse anything but a whole decimal number, so a signed, fractional or hex format names none.
    if (!/^[0-9]+$/.test(text))
        return null;
    const format = parseInt(text, 10);
    return format <= MAX_FORMAT ? format : null;
}

/**
 * True when the raw action string is a validator wire action: its trimmed,
 * upper-cased first field names a validator action and its second field a
 * format that action broadcasts. Aliases are not expanded, as consensus does not.
 * @param {*} data
 * @returns {boolean}
 */
function isValidatorWireAction(data) {
    // Refuse anything but a non-empty string, the only shape a wire action arrives in.
    if (typeof data !== 'string' || data === '')
        return false;
    const parts = data.split('|');
    const name = parts[0].trim().toUpperCase();
    // Refuse a name outside the validator set, own keys only so an inherited name never matches.
    if (!Object.prototype.hasOwnProperty.call(VALIDATOR_WIRE_FORMATS, name))
        return false;
    const format = parseFormat(parts[1]);
    return format !== null && VALIDATOR_WIRE_FORMATS[name].includes(format);
}

module.exports = {
    VALIDATOR_WIRE_FORMATS,
    ATTEST_BATCH_HEAD_VERSION,
    ATTEST_BATCH_CONTINUATION_VERSION,
    isValidatorWireAction
};
