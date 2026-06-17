# Maintainers

This file lists the people responsible for `xchain-encoder`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: encoding formats, PSBT construction, fee logic, API, browser bundle, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-encoder/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Encoding formats | The four encoding formats (OP_RETURN, P2SH, P2WSH, multisig); AES-128-CTR obfuscation; format auto-selection by payload size (`XChainEncoder.js`) |
| PSBT construction | Input selection (largest-first), duplicate removal, change output calculation, two-transaction P2SH/P2WSH orchestration (`XChainEncoder.js`) |
| Fee estimation and capping | Byte-accurate size estimation per format (`TxSizeEstimator.js`); dust floor enforcement; `MAX_FEE_RATE_MULTIPLIER` and `MAX_FEE_RATE_KB` caps |
| Input validation | Centralized parameter validation for all `createTransaction` parameters (`validator.js`) |
| Network configs | Multi-chain support across Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest (`CryptoNetworks.js`) |
| Coin node connector | JSON-RPC calls to `bitcoind`/`litecoind`/`dogecoind` for fee estimates and UTXO queries (`BlockchainConnector.js`) |
| UTXO tracker integration | Optional UTXO sourcing from `xchain-utxo-tracker` (`UtxoTracker.js`) |
| JSON-RPC API | Express server with Helmet headers, optional API key auth, rate limiting, CORS (`src/api.js`) |
| Browser bundle | Browserify build producing `dist/xchain_encoder.min.js` for client-side PSBT generation |
| Tests | The layered suites under `test/` (unit, integration, e2e, boundary, chaos, mutation, regression, smoke, performance) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: stateless request handling (no persistent DB connections), raw parameterized inputs through `validator.js` before any encoding path, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| An encoding bug that could produce a valid-but-wrong fund-moving transaction | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Encoding correctness and any change to how the four formats are selected or constructed.
- Fee policy: rate caps, dust floor, and size estimation behavior.
- API surface: new methods, parameter shapes, and authentication behavior.
- The published browser bundle and its build configuration.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-utxo-tracker`](https://github.com/XChain-platform/xchain-utxo-tracker) | Supplies UTXOs for input selection when `UTXO_TRACKER_URL` is configured |
| [`xchain-sdk`](https://github.com/XChain-platform/xchain-sdk) | Wraps the encoder; SDK consumers sign and broadcast the PSBTs the encoder produces |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: ACTION definitions, encoding formats, obfuscation, wire format |
| [`xchain-node`](https://github.com/XChain-platform/xchain-node) | Installs and runs the encoder as a Docker container |
| Coin nodes (`bitcoind` / `litecoind` / `dogecoind`) | The encoder calls these via JSON-RPC for fee estimates; callers sign and broadcast the returned PSBTs |

The encoder maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
