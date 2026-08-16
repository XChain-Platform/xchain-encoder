#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as three jobs (ci, drift-guards,
# coverage). The pre-push venue gate used to run only `npm run ci`, so a push
# could gate green locally and then go red on GitHub on a job the gate never
# ran (2026-08-15: exactly that, on three repos at once). This script IS the
# local twin of the workflow: every job's run-steps, transcribed, in job
# order. When ci.yml gains or changes a job, change this script in the same
# commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there,
# same as ci-dispatch.sh ships them onto the CI venue before this script ever
# runs). A sibling a GitHub job checks out is REQUIRED here: missing means
# fail loud, never skip, because GitHub will run the step this gate would be
# skipping. This matters doubly for xchain-encoder: several of its own unit
# tests (ActionManifestConformance, coins-conformance, compression,
# envelopeRecognitionGate, sibling-coverage) route on fs.existsSync of the
# sibling and quietly this.skip() when it is absent, so a missing sibling
# does not fail those tests, it just shrinks what they cover. need_sib below
# is what turns that silent shrink into a loud refusal to run at all.
#
# The `ci` job is a reusable workflow (XChain-Platform/.github ci-reusable.yml)
# that simply runs `npm run ci`; the siblings it needs are whatever the venue
# already shipped from .ci-siblings, so no extra checkout step is needed here.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

need_sib xchain-hub xchain-documentation xchain-decoder xchain-sdk

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
run_tier "ci" npm run ci

# --- job: drift-guards -------------------------------------------------
# Recreates the sibling layout (self + xchain-hub side by side) the workflow
# checks out, and runs the same two checks from the same working directories.
sync_coins_check() { (cd "$SIB" && "xchain-hub/bin/sync-coins.sh" --check --only "$(basename "$SELF")"); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'

# --- job: coverage (needs: ci) ------------------------------------------
# The workflow checks out every repo in .ci-siblings before this job so the
# ratchet re-run measures coverage with the same cross-repo tests exercised
# (not skipped), which is exactly the layout need_sib above already requires.
run_tier "coverage ratchet (coverage:check)" npm run coverage:check

echo
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
