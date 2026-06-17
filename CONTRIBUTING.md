# Contributing to XChain Encoder

Thanks for considering a contribution. `xchain-encoder` builds PSBT transactions that move real value, so we trade speed for correctness on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation/tree/master/components/encoder) repository (architecture, configuration, encoding formats, API reference)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-encoder/
├── src/                  encoder core: XChainEncoder, validator, PSBT construction, API, formats
├── test/                 layered suites (unit, integration, fuzz, boundary, chaos, regression, security, smoke, performance)
├── dist/                 browser bundle output (xchain_encoder.min.js)
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform pins Node 22 fleet-wide: the `mariadb` driver (used by the broader platform) is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- A coin node (`bitcoind` / `litecoind` / `dogecoind`) for integration and e2e runs. For local work, the `xchain-regtest-miner` plus a regtest stack is the easiest path. Unit and fuzz suites require no external services.

### First-time install

```bash
git clone https://github.com/XChain-platform/xchain-encoder.git
cd xchain-encoder
npm install
```

Create a `.env` (see [`README.md`](./README.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm run api        # start the JSON-RPC API server
npm run build      # production browser bundle -> dist/xchain_encoder.min.js
```

---

## Tests

The encoder runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke | `npm run smoke-test` | No |
| Unit | `npm run test:unit` | No |
| Security | `npm run test:security` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Fuzz | `npm run test:fuzz` | No |
| Boundary | `npm run test:boundary` | No |
| Chaos | `npm run test:chaos` | No |
| Regression | `npm run test:regression` | No |
| Integration | `npm run test:integration` | bitcoind regtest |

Run the no-external-services tiers before every commit (`npm run ci`, `npm run test:security`). Because this service builds fund-moving transactions, new encoding paths, PSBT construction changes, and fee logic should come with fuzz and security coverage. Any path where a malformed input could produce a valid-looking but wrong transaction warrants a regression test.

---

## Coding style

- **Plain JavaScript**, no TypeScript. No database, no ORM; the encoder is fully stateless.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a consensus-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Correctness is fund-critical.** A wrong output address, wrong amount, or wrong encoding produces a transaction that loses or misdirects real value. Treat encoding changes with the same care as consensus logic in the indexer.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-platform/xchain-encoder/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

## Code of Conduct

We follow our [Code of Conduct](./CODE_OF_CONDUCT.md), adapted from the Contributor Covenant 2.1. Be kind, assume good faith, and disagree without being a jerk.

---

Last reviewed: 2026-06-16.
