# APoW Wallet Protocol v2 — Agentic Wallet Hardening for apow-cli, plus Grind Service Wallet Split

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows `~/.codex/PLANS.md`. It is fully self-contained: an implementer with only the current working tree and this file can execute it end to end.

## Purpose / Big Picture

APoW is an AI-agent mining protocol on Base mainnet. Agents run `apow-cli` (published on npm, currently v0.11.19) to mine the $AGENT token. The protocol's contracts are immutable and require every mining transaction to be signed directly by a plain externally-owned account (EOA) whose private key is available to the mining process roughly every 10 seconds. That makes the mining wallet permanently "hot," and today that hot key can sign anything, accumulates all mined value, and its keystore password leaks into the environment of every child process the CLI spawns.

After this plan, an agent or human running `apow-cli` gets a wallet protocol where: the hot mining wallet automatically sweeps mined $AGENT to a payout address the user controls elsewhere (so a key leak loses dust, not a stack); the key refuses to sign anything that is not a known APoW operation within configured spend caps (so a hijacked or prompt-injected agent cannot drain it); the keystore password never reaches child processes, `.env` files, or plaintext exports without an explicit danger gate; and every signature is recorded in a tamper-evident local audit log. Separately, the cloud-mining GPU service (`grind.apow.io`) stops using one hot wallet as both its payment-settlement signer and its revenue destination, so revenue settles directly to a cold treasury before paid traffic resumes.

Observable outcome when done: `npm test` passes in `apow-cli` with new policy/signer/audit suites; a real mainnet `apow mine` run completes under enforced policy; `apow wallet sweep` moves $AGENT to a configured payout address and the transfer is visible on Basescan; a spawned grinder child process demonstrably has no `KEYSTORE_PASSWORD` in its environment; and `https://grind.apow.io/ops/economics` reports a split-wallet check passing.

## Progress

- [x] (2026-06-10) Pre-implementation save-state pushed to GitHub snapshot branches. Branch `snapshot/wallet-protocol-v2-pre-20260610` exists on `apow-cli`, `apow-grind`, `apow-core`, `apow-splash`, `base-skills`, `apow-mini`, and `apow-pool`.
- [x] (2026-06-10) Tracked this ExecPlan in `apow-cli/plans/wallet-protocol-v2.md`; the original umbrella copy at `/Users/aklo/projects/apow/plans/wallet-protocol-v2.md` is local-only because the APoW workspace root is not a Git repository.
- [x] (2026-06-10) M0: test harness added to apow-cli (`npm test` runs node:test via tsx; wallet-store tests pass; package dry-run excludes tests)
- [x] (2026-06-10) M1: signer abstraction + GuardedAccount chokepoint wired through wallet.ts, x402.ts, grinder-http.ts, miner.ts, dashboard.ts, smhl.ts; audit log writing enabled
- [x] (2026-06-10) M2: policy engine enforcing with built-in allowlist; policy.json + spend ledger; `apow policy` command group; errors.ts classification; preflight row
- [x] (2026-06-10) M3: credential hardening (KEYSTORE_PASSWORD_CMD; writeEnvFile guard; process.env password removal; childEnv scrubbing on all spawns; `apow wallet migrate`; plaintext danger gates)
- [x] (2026-06-10) M4: payout + sweep (sweep.ts; `apow wallet payout set/show`, `apow wallet sweep [--all]`; auto-sweep in mining loop; stats rows)
- [x] (2026-06-10) M5: skill.md "APoW Wallet Protocol" section + AWAL interop added; synced to all four copies; README/.env.example/changelog updated; apow-splash docs sync run
- [ ] Soak: fleet run with APOW_POLICY=warn for several days; zero unexpected denials confirmed in audit logs
- [ ] Publish v0.12.0 (requires explicit AKLO approval)
- [x] (2026-06-10) M6 code-only: apow-grind split-wallet health/economics gate implemented and tested. Deployment, facilitator rotation, treasury selection, old-wallet sweep, and on-chain verification remain approval-gated and not executed.
- [ ] Retrospective written

## Surprises & Discoveries

Recorded during planning research (2026-06-10); implementers should append their own.

- Observation: the keystore password is copied into `process.env.KEYSTORE_PASSWORD` at `apow-cli/src/index.ts:105` and `:114`, and the CLI spawns child processes (GPU grinder binaries in `grinder-native.ts`, `claude`/`codex` CLIs in `smhl.ts`) that inherit the full environment. The password therefore leaks into every child's environment.
  Evidence: code read of index.ts/grinder-native.ts/smhl.ts during audit.
- Observation: a real plaintext key artifact exists at the workspace root (`/Users/aklo/projects/apow/wallet-0xB6120fA7ef67c1BB457169cF56e0d07C894633B8.txt`, mode 0600), confirming the plaintext export path gets used in practice. Do not print or open it.
- Observation: `apow-cli/src/wallet.ts` appends an ERC-8021 attribution `dataSuffix` to calldata. Any policy decoder using strict `decodeFunctionData` will fail on suffixed calldata; the decoder must slice the 4-byte selector and read arguments at fixed 32-byte offsets, ignoring trailing bytes.
- Observation: both x402 client libraries accept signer objects, so the raw private key does not need to be passed around: `@quicknode/x402` accepts `evmSigner` (a `ClientEvmSigner` with `address` + `signTypedData`), and `@x402/fetch`'s `registerExactEvmScheme` accepts any viem-account-shaped signer. The lone exception is `@blockrun/clawrouter`, whose `ProxyOptions.wallet` requires the raw key (mint-time only, in-process proxy, and it exposes a per-session max-spend option).
- Observation: Coinbase AWAL (Agentic Wallets, launched 2026-02-11) cannot mine APoW. Its CLI exposes only balance/send/trade/fund/x402-pay; no arbitrary contract calls; keys live in Coinbase's TEE. Combined with the immutable `msg.sender == tx.origin` check, AWAL can only fund a mining wallet, receive sweeps, or pay x402 endpoints.
- Observation: the apow-grind dual-role wallet problem is operational, not architectural. The Worker already has two separate env vars (`SERVICE_WALLET` = x402 payTo, `FACILITATOR_PRIVATE_KEY` = settlement signer); both are currently set to the same wallet (`0x85ed004AFF50FaD46bC353171B0573b7a8F93642`). Because x402 exact-scheme settlement transfers USDC payer→payTo directly, pointing `SERVICE_WALLET` at a cold treasury removes any need for revenue-sweep code.
- Observation: the workspace root `/Users/aklo/projects/apow` is not a Git repository, so rollback state must be saved per sub-repo rather than by committing `plans/wallet-protocol-v2.md` at the umbrella level.
  Evidence: `git status -sb` at the workspace root returned `fatal: not a git repository`.
- Observation: before implementation, `apow-cli` already had a dirty but compiling keystore-first baseline, while no `src/signer`, `src/policy`, `src/sweep`, or `src/secure-env` modules existed yet.
  Evidence: `npm run build` in `apow-cli` passed on 2026-06-10; `rg --files src | rg '(^|/)(signer|policy|sweep|secure-env)|\.test\.ts$'` returned no files.
- Observation: `apow-grind` already contained the prior economics hardening work and tests, but not the split-wallet gate.
  Evidence: `npm run typecheck` and `npm test` in `apow-grind/worker` passed 14 tests on 2026-06-10; `rg` found `SERVICE_WALLET` and `FACILITATOR_PRIVATE_KEY` use but no `REQUIRE_SPLIT_WALLETS` or dual-role warning.

## Decision Log

- Decision: self-custody-first; no CDP/Coinbase code dependency. AWAL is documented end-user interop only (fund source, payout target, x402 payer). The `ApowSigner` interface leaves a seam for a future CDP Server Wallet backend, but none is built now.
  Rationale: project-side CDP/AWAL accounts are identity-linked (email/KYC), which is unacceptable for the anonymous Agentoshi identity; AWAL cannot call `mine()` anyway; users wanting custody-light mining are better served by the cloud-mining app. AKLO confirmed "Core, no CDP code" on 2026-06-10.
- Decision: scope of this round is apow-cli Wallet Protocol v2 (M0–M5) plus the apow-grind wallet split (M6). apow-mini spend caps/payout/withdrawals are deferred to the cloud-mining launch round.
  Rationale: the CLI is the live npm surface holding all real key risk today; the grind split must land before paid cloud traffic resumes; apow-mini has its own launch blockers (private RPC, SESSION_SECRET, funded E2E) that precede its wallet work. AKLO confirmed on 2026-06-10.
- Decision: sweep runs synchronously between confirmed mines, never concurrently with a pending mine transaction.
  Rationale: mine() submissions and sweeps share one EOA nonce sequence; an async sweep stuck in the mempool would head-of-line-block the next mine. Sweeping inline with a receipt wait (30 s timeout, then continue) cannot deadlock the loop.
- Decision: policy ships enforce-by-default in v0.12.0, but only after a warn-mode soak on the operator's own fleet, using the runtime `APOW_POLICY=warn` flag rather than a separate release.
  Rationale: the built-in allowlist was derived from an audited inventory of every signing call site, so enforce should be safe; the soak proves it on real traffic with zero publish risk.
- Decision: `signMessage` and raw hash signing are deny-class. EIP-2612 Permit / Permit2 typed data are denied. Only EIP-3009 `TransferWithAuthorization`/`ReceiveWithAuthorization` against canonical Base USDC are allowed as typed data.
  Rationale: no current CLI flow uses message signing or Permit; these are the classic drain vectors.
- Decision: auto-lock/TTL for the unlocked key is descoped.
  Rationale: mining signs every ~10 s, so the key must stay hot in the only long-running session type; removing the password from `process.env` is the real win. Revisit only if a long-lived non-mining daemon appears.
- Decision: no new runtime dependencies for policy/audit/sweep (node:crypto + viem + existing `ox`).
  Rationale: supply-chain surface is opsec surface.
- Decision: implementation work starts from branch `feature/wallet-protocol-v2`, based on the pushed snapshot branch, in each touched repo.
  Rationale: the snapshot branches remain stable rollback anchors, while implementation commits can proceed without rewriting the saved state.
  Date/Author: 2026-06-10 / Codex.

## Outcomes & Retrospective

2026-06-10 implementation outcome: `apow-cli` now routes local signing through a guarded account, enforces a local allowlist policy by default, logs audit/spend JSONL locally, supports password-command unlocks, scrubs child process environments, and adds payout/sweep commands. `apow-grind` now reports split-wallet status and can block serving when split wallets are required. Approval-gated operations were intentionally not executed: npm publish, Worker deploy, facilitator key rotation, treasury selection, old wallet sweep, mainnet smoke mining/sweeping, and fleet soak.

## Context and Orientation

The workspace is `/Users/aklo/projects/apow`, a multi-repo workspace. Repos relevant here:

- `apow-cli/` — TypeScript mining CLI (viem), published to npm as `apow-cli`. All work in M0–M5 happens here.
- `apow-core/` — Foundry Solidity contracts, deployed and renounced on Base mainnet. READ ONLY: AgentCoin `0x12577CF0D8a07363224D6909c54C056A183e13b3`, MiningAgent `0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D`. Never modify `apow-core/contracts/src/` — owner is `address(0)`; changes can never deploy.
- `apow-grind/` — Cloudflare Worker (`worker/`) + RunPod GPU backend serving x402-paid nonce grinding at `https://grind.apow.io`. M6 happens here.
- `apow-splash/`, `base-skills/` — receive synced copies of `skill.md` in M5.
- `apow-mini/`, `apow-pool/` — OUT OF SCOPE this round (apow-mini = cloud-mining web app, next round; apow-pool = dormant pool agent).

Definitions used throughout:

- "EOA" — externally-owned account: a plain private-key wallet, as opposed to a smart-contract account.
- "Keystore" — an encrypted JSON file (Web3 Secret Storage v3, scrypt KDF) holding the private key, produced by the `ox` library. Lives at `~/.apow/keystores/wallet-<address>.json`, file mode 0600, dir 0700. Implemented in `apow-cli/src/wallet-store.ts`.
- "x402" — an HTTP payment protocol: a server replies `402 Payment Required` with terms; the client signs a USDC EIP-3009 authorization (a typed-data signature letting the payee pull exact USDC); the server settles it on-chain and serves the request. The CLI pays three x402 services: QuickNode (RPC), ClawRouter/BlockRun (LLM for minting), and grind.apow.io (GPU grinding).
- "EIP-3009" — USDC's `TransferWithAuthorization` typed-data scheme. The signed message contains `to` (payee) and `value` (exact USDC amount), which is what the policy engine inspects and budgets.
- "ERC-8021 dataSuffix" — attribution bytes appended after valid calldata. Harmless on-chain, but breaks strict ABI decoding; see Surprises.
- "Policy guard / GuardedAccount" — a wrapper around the viem account object that intercepts every signing method, evaluates the request against policy, writes an audit entry, and either signs or throws.

Hard protocol constraints (verified in source; these shape everything):

- `apow-core/contracts/src/AgentCoin.sol:79` and `MiningAgent.sol:72`: `require(msg.sender == tx.origin, "No contracts")` — mining and rig-minting must be direct EOA transactions. No ERC-4337, no relayers, no sponsored gas, no smart accounts, no Coinbase-held keys signing via enclave APIs unless that backend can produce a plain signed EOA transaction (CDP can, but is out of scope per Decision Log).
- `AgentCoin.sol:81`: `require(miningAgent.ownerOf(tokenId) == msg.sender)` — the mining EOA must hold the rig NFT.
- `AgentCoin.sol:92`: `_mint(msg.sender, reward)` — rewards accrue in the mining EOA. Hence sweep.

Current wallet implementation in `apow-cli/src` (verified at v0.11.19):

- `wallet-store.ts` — keystore save/load (`ox` `Keystore.scryptAsync` + `encrypt`/`decrypt`), plus `savePlaintextImportFile()` writing `wallet-<addr>.txt` to CWD.
- `config.ts` — wallet resolution: `PRIVATE_KEY` env (legacy) → `KEYSTORE_PATH` + password from `KEYSTORE_PASSWORD`/`APOW_KEYSTORE_PASSWORD` env (`config.ts:111-114`) or interactive prompt. Module singleton `config`; `writeEnvFile()` (`config.ts:276`) persists settings to `.env` (currently writes `KEYSTORE_PATH`, not passwords). `reloadConfig()` exists.
- `wallet.ts` — module-level viem `account`/`walletClient`/`publicClient` singletons built from `config.privateKey` (four `privateKeyToAccount` sites near lines 24, 42, 66, 83); exports `requireWallet()`, `getFundingClients()`, `reinitClients()`; appends the ERC-8021 `dataSuffix`.
- `index.ts` — commander CLI: setup wizard (Easy Mode), `wallet new/show/export/fund`, dashboard start (passes the private key at ~line 950), browser open spawn (~line 958). Password handling bug at lines 105/114 (see Surprises).
- `miner.ts` — mining loop; submits `mine()` (~line 641); calls `grindNonceHttp` with `config.privateKey!` (~line 541); `waitForNextBlock` after receipt (~line 686).
- `mint.ts` — rig mint flow (`getChallenge` + `mint`, ~lines 143/213).
- `x402.ts` — QuickNode x402 RPC transport; currently passes `evmPrivateKey` (~line 17).
- `grinder-http.ts` — grind.apow.io client; builds its own account from the raw key (~lines 43–49) for `@x402/fetch` + `registerExactEvmScheme`.
- `smhl.ts` — SMHL solver; ClawRouter proxy start (~lines 347–349) requires the raw key; `stopClawRouter` exists.
- `bridge/uniswap.ts` — fund-flow swaps via SwapRouter02 (writes at ~lines 114/164/199).
- `errors.ts` — error classification driving retry behavior; `preflight.ts` — preflight checks; `stats.ts` — stats output; `dashboard.ts` — local dashboard (port 3847).
- `skill.md` — the agent onboarding document; this IS the de-facto wallet protocol agents follow. Synced copies: `apow-core/docs/skill.md`, `apow-splash/public/skill.md`, `base-skills/skills/apow-mining/SKILL.md`; apow-splash additionally regenerates a docs page via `npm run sync-docs`.

Key external addresses (Base mainnet): USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`.

Operational safety rules binding on the implementer:

- Push identity for ALL apow repos is `Agentoshi` ONLY, via `~/.claude/tools/git-push-as.sh Agentoshi <remote> <branch>`. Never plain `git push` (SSH key belongs to aklo360). Never mention aklo360 in any Agentoshi commit/PR/issue.
- Never read or print `.env`, `.dev.vars`, `wallet-*.txt`, keystore contents, private keys, passwords, or private RPC URLs. The user livestreams; terminal output is public.
- No telemetry, no phone-home, no remote policy fetching. skill.md's "Zero Telemetry" section must remain literally true.
- Explicit AKLO approval is required before: `npm publish`, any `wrangler deploy` or `wrangler secret put`, generating/rotating the facilitator key, choosing the treasury address, and the one-time sweep of the old grind wallet.
- After creating ANY new wallet/credential in M6, immediately record address + key storage location + purpose in the project wallet registry (`/Users/aklo/.claude/projects/-Users-aklo-projects-apow/memory/MEMORY.md`) before using it on-chain.

## Plan of Work

### Milestone 0 — Test harness

apow-cli has no test infrastructure. Add a `test` script to `apow-cli/package.json` running the Node built-in test runner through the existing `tsx` devDependency:

    "test": "tsx --test src/**/*.test.ts"

Exclude `src/**/*.test.ts` from the build in `tsconfig.json` so tests never ship in `dist/`. Create `src/wallet-store.test.ts` covering: encrypt→decrypt round-trip using a temp `HOME`, created file mode is 0600 and keystore dir 0700, and `detectWalletAddressFromFilename` vectors. Acceptance: `npm test` passes; `npm run build` output unchanged; `npm pack --dry-run` lists no test files.

### Milestone 1 — Signer abstraction, GuardedAccount, audit log (observe mode)

Goal: every ECDSA signature in the CLI flows through one wrapper that logs and (in M2) enforces; the raw key becomes reachable from exactly one module. Behavior must not change in this milestone — the guard runs in observe mode (always allow, log verdicts).

New module `src/signer/types.ts`:

    export interface ApowSigner {
      readonly address: Address;
      readonly kind: "keystore" | "env-key"; // future: "cdp-server-wallet"
      readonly account: LocalAccount;        // the guarded viem account
      unsafeRawKeyFor(consumer: "clawrouter"): Hex; // audited escape hatch
    }

New `src/signer/local-keystore.ts`: builds the base `PrivateKeyAccount` from the keystore-derived key and keeps the raw key in module-closure scope only. New `src/signer/guarded-account.ts`: `createGuardedAccount(base, ctx)` using `toAccount()` from `viem/accounts`, intercepting `signTransaction`, `signTypedData`, `signMessage`, and raw `sign`. Each interception calls the policy evaluator (M2; observe mode in M1) and appends an audit entry. Guarded signing must produce byte-identical output to the unwrapped account for identical inputs — this is a unit test, not an assumption.

New `src/policy/audit-log.ts`: hash-chained, append-only JSONL at `~/.apow/audit-<address>.jsonl` (file 0600, dir 0700, `O_APPEND` single-line writes; per-address files so parallel miners never interleave chains). Entry fields: `ts`, `seq`, `prev` (sha256 of previous line; genesis `"0x0"`), `kind` (`mine|mint|challenge|sweep|x402|fund-swap|eth-send|raw-key-handout|other`), `target`, `selector?`, `valueWei?`, `usdc?`, `payee?`, `verdict`, `policyRule?`, `txHash?`, `context`. Never log keys, passwords, calldata bodies, or RPC URLs. New `src/policy/context.ts`: `setSignerContext("mine"|"mint"|"fund"|"sweep"|"wallet-fund"|"dashboard")`, called at the top of each command action in `index.ts`.

Rewire call sites, preserving all existing exports so consumers compile untouched: in `wallet.ts` replace the four `privateKeyToAccount(config.privateKey)` sites with `getSigner().account`; in `x402.ts` pass `evmSigner` (signer object) instead of `evmPrivateKey`, keeping `paymentModel: "pay-per-request"`, with a one-release fallback env `APOW_X402_LEGACY_SIGNER=true` restoring the old path; in `grinder-http.ts` accept a `LocalAccount` instead of a key (drop the internal `privateKeyToAccount`); in `miner.ts:541` pass the in-scope `account`; in `dashboard.ts` accept a signer rather than `privateKey` (update caller in `index.ts`); in `smhl.ts:347-349` obtain the ClawRouter key via `getSigner().unsafeRawKeyFor("clawrouter")` (writes a `raw-key-handout` audit entry) and pass ClawRouter's per-session max-spend option. Mark `config.privateKey` `@deprecated` but keep it populated for one minor (some modules check truthiness only).

### Milestone 2 — Policy enforcement, policy.json, spend ledger (ships with M1 as v0.12.0)

New `src/policy/policy.ts`: `loadPolicy()` merges `~/.apow/policy.json` (override path `APOW_POLICY_PATH`) over built-ins; modes `enforce` (default) | `warn` | `off` via file or `APOW_POLICY` env (emergency escape hatch that prints a loud warning); `writeDefaultPolicyFile()` called by the setup wizard; `evaluateTx()`, `evaluateTypedData()`; `PolicyDeniedError` carrying rule id + a one-line fix hint.

New `src/policy/decode.ts`: suffix-tolerant calldata inspection — `selector = data.slice(0, 10)`, arguments read at fixed 32-byte offsets (ERC-20 `transfer`: recipient bytes 4..36, amount 36..68), trailing ERC-8021 suffix ignored. `parseEip3009(typedData)`: require `domain.verifyingContract` == canonical Base USDC, `primaryType` in {`TransferWithAuthorization`, `ReceiveWithAuthorization`}, return `{payee, usdc, validBefore}`. Deny `Permit`/`PermitTransferFrom` primary types.

New `src/policy/spend-ledger.ts`: `~/.apow/spend-<address>.jsonl`; `recordSpend({kind, usdc, payee})` written at signTypedData time (EIP-3009 `value` is exact); `spentTodayUsdc()` with UTC-day buckets. No RPC calls in the signing hot path.

Built-in allowlist (Base mainnet; testnet variant keyed off `chainName`):

| Rule | Bound |
|---|---|
| `AgentCoin.mine(uint256,string,uint256)` | `to == config.agentCoinAddress`, value == 0 |
| `MiningAgent.getChallenge(address)` / `mint(string)` | `to == config.miningAgentAddress`, value ≤ maxMintEth (default 0.01 ETH) |
| `AGENT.transfer(address,uint256)` | recipient == configured payout address only (sweep) |
| `USDC.approve(address,uint256)` | spender == SwapRouter02, context == `fund` |
| SwapRouter02 `exactInputSingle`/`multicall` | context == `fund`, value ≤ maxSwapEth (default 0.02 ETH) |
| Plain ETH transfer (empty calldata) | value ≤ maxEthTransferEth (default 0.05 ETH) |
| EIP-3009 USDC typed data | usdc ≤ maxPerRequestUsdc (default 1.00; grind floor is 0.301) AND spentToday + usdc ≤ dailyUsdc (default 20.00). Payee pinning is opt-in (`payees: [...]`) because x402 payTo addresses arrive dynamically in 402 responses |
| Everything else, incl. `signMessage`/raw `sign` | deny |

Wire-up: flip the GuardedAccount from observe to consult `loadPolicy()` and throw `PolicyDeniedError` in enforce mode. In `errors.ts`, classify `PolicyDeniedError` as category `setup` so the mining loop exits with the hint instead of entering its 10x retry storm. In `index.ts`, add `apow policy show|init|set mode <enforce|warn|off>`, and call `writeDefaultPolicyFile()` from the setup wizard right after `writeEnvFile()` (~line 411). In `preflight.ts`, add a non-blocking row showing policy mode + today's remaining x402 budget.

### Milestone 3 — Credential hardening

In `config.ts`: add `KEYSTORE_PASSWORD_CMD` / `APOW_KEYSTORE_PASSWORD_CMD` to `resolveKeystorePassword()` — run via `spawnSync(cmd, {shell: true, timeout: 10_000})`, trim stdout, never echo; precedence env > cmd > interactive prompt. This enables macOS Keychain (`security find-generic-password -s apow-keystore -w`), Linux `secret-tool lookup service apow`, or any agent secret manager. Harden `writeEnvFile()` to throw if asked to persist any `KEYSTORE_PASSWORD*` key or a non-empty `PRIVATE_KEY` (the existing `PRIVATE_KEY: ""` clearing write stays legal).

In `index.ts`: remove both `process.env.KEYSTORE_PASSWORD = ...` assignments (lines 105, 114); replace with an in-memory `setSessionPassword()` in new `src/signer/session.ts`. New `src/secure-env.ts`: `childEnv()` returns a copy of `process.env` minus `KEYSTORE_PASSWORD`, `APOW_KEYSTORE_PASSWORD`, `PRIVATE_KEY`; pass `env: childEnv()` to every `spawn`/`execFile` in `grinder-native.ts`, `smhl.ts` (claude-code/codex providers), and the browser-open spawn in `index.ts` (~line 958).

Add `apow wallet migrate`: if `PRIVATE_KEY` env is set, encrypt it into a keystore, write `KEYSTORE_PATH` to `.env`, clear `PRIVATE_KEY` from `.env`, and print an instruction to unset the env var. `main()` prints a one-line deprecation warning whenever `walletSource === "private-key"` (hard-fail comes in 0.13, one release later). Danger-gate plaintext: remove `--plaintext` from `wallet new`; `wallet export --plaintext` requires `--i-understand-plaintext-risk` AND (when interactive) typing `PLAINTEXT`; suggest deleting the file after import.

### Milestone 4 — Split-role wallet: payout + auto-sweep

New `src/sweep.ts`. Payout address stored in `policy.json` (`payout` field; `APOW_PAYOUT_ADDRESS` env override; refuse payout == mining address; checksum-validate; interactive confirm shows first/last 6 chars). `runSweep({all?, minAgent?})`: read AGENT `balanceOf(mining)` (AgentCoin is the ERC-20); if balance ≥ threshold (default 25 AGENT, `APOW_SWEEP_THRESHOLD_AGENT`) and ETH ≥ 2x estimated mine-gas reserve, submit `AGENT.transfer(payout, balance)` and wait for the receipt synchronously (30 s timeout, then abandon and continue — never let a stuck sweep block mining; see Decision Log nonce rationale). `--all` additionally sends ETH above 4x gas reserve and USDC above a $5 working balance, all under the same policy rules. `maybeAutoSweep()` for the mining loop: never throws; on failure, warn + audit entry + back off for 50 mines.

Wire-up: in `miner.ts` after `waitForNextBlock(receipt.blockNumber)` (~line 686), call `await maybeAutoSweep(...)` when a payout is configured (`policy.sweep.auto` defaults true once payout is set). In `index.ts`: `apow wallet payout set <addr>` / `payout show`, `apow wallet sweep [--all]`. In `stats.ts`: payout address, AGENT held at payout, and "unswept" balance rows. Do NOT gate mining on payout configuration — sweep is opt-in by setting a payout.

### Milestone 5 — skill.md protocol rewrite + docs sync

Canonical file `apow-cli/skill.md` gains a top-level "APoW Wallet Protocol" section: lifecycle (generate → backup → fund minimal → set payout → mine → auto-sweep), an annotated default `policy.json`, audit/spend file locations, `KEYSTORE_PASSWORD_CMD` recipes for macOS/Linux, payout/sweep commands, and explicit never-export rules (never print, paste, or transmit the private key or keystore password; never write either into `.env` or chat).

AWAL interop subsection (end-user guidance only): AWAL is Coinbase's Agentic Wallet (`npx awal`, email-OTP, keys in Coinbase's TEE). An AWAL-equipped agent can fund its APoW mining wallet (`awal send` ETH/USDC to the mining address), set its AWAL address as the sweep payout target (note: $AGENT is a custom ERC-20 — visible on Basescan even if the awal CLI does not list it), and pay `grind.apow.io` directly via `awal x402 pay` for non-mining API use. State plainly: AWAL cannot mine (no arbitrary contract calls; the `tx.origin` rule blocks smart-account workarounds), and APoW project infrastructure never depends on AWAL/CDP because those are identity-linked.

Update the env-var table (new vars below), the troubleshooting table (a "Policy denied: ..." row), and the Security and Trust section (policy guard, audit chain, password-cmd, child-env scrubbing). Sync to: `apow-core/docs/skill.md`, `apow-splash/public/skill.md`, `base-skills/skills/apow-mining/SKILL.md`, then run `npm run sync-docs` in `apow-splash` (its `out/` is build output — never hand-edit). Also update `apow-cli/README.md`, `.env.example`, and the workspace `changelog.md`. Any apow.io website deploy is a separate approval-gated step.

New configuration surface introduced across M2–M4:

| Var | Default | Purpose |
|---|---|---|
| `KEYSTORE_PASSWORD_CMD` / `APOW_KEYSTORE_PASSWORD_CMD` | — | command whose stdout is the keystore password |
| `APOW_POLICY` | `enforce` | `enforce` \| `warn` \| `off` |
| `APOW_POLICY_PATH` | `~/.apow/policy.json` | policy file override |
| `APOW_PAYOUT_ADDRESS` | — | overrides policy.json payout |
| `APOW_SWEEP_THRESHOLD_AGENT` | `25` | auto-sweep trigger |
| `APOW_X402_DAILY_USDC` | `20` | daily x402 budget |
| `APOW_X402_MAX_PER_REQUEST_USDC` | `1.0` | per-signature cap |
| `APOW_X402_LEGACY_SIGNER` | unset | one-release fallback to raw-key QuickNode path |

Runtime files (all 0600 in `~/.apow/`, dir 0700): `policy.json`, `audit-<address>.jsonl`, `spend-<address>.jsonl`.

### Milestone 6 — apow-grind wallet split (before RunPod re-enable / paid traffic)

Background: `grind.apow.io` is live but paused (RunPod re-enable keeps recreating standby workers; the Worker's safety gate refuses paid traffic until fixed — that fix is a separate workstream). Today one hot wallet is both the x402 revenue payTo (`SERVICE_WALLET`) and the settlement signer (`FACILITATOR_PRIVATE_KEY`). Split them so revenue settles directly to a cold treasury and the hot key holds only gas dust.

Code change in `apow-grind/worker/src/index.ts`: in the `/ops/economics` and `/health` handlers, derive the facilitator address from `FACILITATOR_PRIVATE_KEY` and compare with `SERVICE_WALLET`; if equal, append warning `dual-role wallet: settlement signer == revenue payTo`, and when new env `REQUIRE_SPLIT_WALLETS=true` (set true in production config after rotation), also force `safe_to_serve=false`. Add a facilitator gas-floor warning when its ETH balance < 0.0005.

Ops runbook — EVERY step below requires explicit AKLO approval before execution, and the new credentials must be recorded in the project wallet registry (MEMORY.md) BEFORE first on-chain use:

1. Generate a fresh facilitator key locally (never echo it); fund with 0.002 ETH for settlement gas; `wrangler secret put FACILITATOR_PRIVATE_KEY` in `apow-grind/worker`.
2. AKLO designates the cold treasury address (hardware or air-gapped keystore — NOT AWAL/CDP, which are identity-linked). Set `SERVICE_WALLET` to it.
3. Deploy the Worker (approval-gated), confirm `/ops/economics` shows the split-wallet check green.
4. One-time manual sweep of the old dual-role wallet `0x85ed004AFF50FaD46bC353171B0573b7a8F93642` (accumulated USDC including the $0.301 smoke revenue, plus residual ETH beyond nothing — the wallet retires) to the treasury. Verify on Basescan.
5. After the separate RunPod re-enable fix lands, run one funded grind and verify on-chain that USDC settled payer→treasury directly.

## Concrete Steps

All commands run from the repo noted. Never run plain `git push`.

    cd /Users/aklo/projects/apow/apow-cli
    npm install            # only if lockfile changes; no new runtime deps expected
    npm test               # new in M0; must pass at every milestone
    npm run build          # tsc strict; must stay clean
    npm pack --dry-run     # verify dist contents, no test files, new dist dirs present

Dry-run verification with an isolated HOME (no real funds involved):

    cd /Users/aklo/projects/apow/apow-cli
    HOME=$(mktemp -d) node dist/index.js wallet new        # expect: keystore path printed, no key printed
    HOME=... node dist/index.js policy show                # expect: defaults + mode enforce
    # child-env proof: with a wallet configured, run a mine dry path or grinder detection and
    # inspect the spawned child's /proc-equivalent env via a temporary debug hook or by pointing
    # GRINDER path at a stub script that dumps env to a file; assert no KEYSTORE_PASSWORD.

Fleet soak (Mac Mini runs the live fleet under launchd label `com.apow.mining`; restart it properly, never just kill):

    ssh llphant
    # set APOW_POLICY=warn in the fleet env, restart the launchd service, mine for several days
    # then: grep '"verdict":"deny"' ~/.apow/audit-*.jsonl  → expect zero unexpected denials

Publish (approval-gated):

    cd /Users/aklo/projects/apow/apow-cli
    npm publish            # ONLY after AKLO approves v0.12.0

apow-grind (M6):

    cd /Users/aklo/projects/apow/apow-grind/worker
    npm run typecheck && npm test
    npx wrangler deploy    # ONLY after AKLO approves
    curl -s https://grind.apow.io/ops/economics | jq .     # expect split-wallet check green

Git hygiene per repo at each milestone: commit with the local Agentoshi identity (each apow sub-repo already has local git config set to Agentoshi; verify with `git config user.name` before committing), push via `~/.claude/tools/git-push-as.sh Agentoshi origin main`.

## Validation and Acceptance

Unit (must all pass via `npm test`): policy vectors — every allowlist row has an allow case and an over-cap/unknown-target deny case; EIP-3009 per-request and daily budget enforcement including UTC-day rollover; ERC-8021-suffixed calldata decodes correctly; Permit/Permit2 denied; guarded-vs-plain signature byte parity on identical inputs; audit chain append/verify and tamper detection (mutate a middle line, expect verification failure); password-cmd resolution precedence; sweep math retains gas reserves; `warn` mode never throws.

Behavioral acceptance:

- `apow wallet new` on a clean HOME creates a 0600 keystore and prints no key material.
- `apow wallet export --plaintext` refuses without the danger flag + typed confirmation.
- `apow wallet migrate` converts a throwaway `PRIVATE_KEY` env into a keystore and clears `.env`.
- A spawned grinder child's environment contains no `KEYSTORE_PASSWORD` (stub-script proof).
- Testnet (`baseSepolia` config): mint a rig, run 5 mine cycles under `APOW_POLICY=enforce`; on a scratch branch, add a deliberate unknown-contract call and confirm clean `PolicyDeniedError` exit with hint (no retry storm).
- Mainnet smoke with the existing funded wallet: one x402 QuickNode RPC call through the new `evmSigner` path; one paid grind (~$0.301) whose spend-ledger row matches the on-chain `TransferWithAuthorization` USDC event on Basescan; one real `mine()` under enforce; `apow wallet sweep` moves AGENT to the payout address (verify the ERC-20 `Transfer` on Basescan); audit chain verifies; Basescan shows no unexpected USDC approvals for the mining EOA.
- apow-grind: `/ops/economics` shows `safe_to_serve` logic including the split-wallet check; after rotation + (separate) RunPod fix, a funded grind settles USDC payer→treasury on-chain.
- Docs: all four skill.md copies updated and identical in protocol content; `npm run sync-docs` in apow-splash regenerates its docs page.

## Idempotence and Recovery

- All new files are additive; re-running setup/`policy init` overwrites only the policy file after confirmation. Audit/spend ledgers are append-only.
- Rollback for policy issues in the field is runtime, not a release: `APOW_POLICY=warn` (log-only) or `off` (emergency). `APOW_X402_LEGACY_SIGNER=true` restores the prior QuickNode signing path for one release.
- v0.12.0 ships M0+M1+M2 together only after the warn-mode fleet soak shows zero unexpected denials. v0.12.x ships M3+M4 additively. v0.13.0 makes `PRIVATE_KEY` import-only and graduates `signMessage` deny from warn to enforce if the soak showed zero hits.
- M6 recovery: keep the old facilitator secret value until the new one has settled at least one verified payment, then retire it. The old dual-role wallet is swept only after the new configuration is verified live. If a deploy misbehaves, `wrangler rollback` / redeploy previous commit; secrets can be re-pointed at the old values during the window where they still exist.
- Irreversible steps (publish, deploys, key rotation, treasury selection, sweeping the old wallet) each require explicit AKLO confirmation at execution time; this plan does not pre-authorize them.

## Artifacts and Notes

Planning research evidence (2026-06-10):

- Cloud mining status: grind.apow.io deployed + hardened (D1 economics ledger, paid-autostart, safety gates), paused on the RunPod standby-worker re-enable issue; one funded smoke settled $0.301 USDC. apow-mini (Base App cloud-mining console, non-custodial in-browser mining EOA) deployed at apow-mini.aklo.workers.dev, pre-launch. These are context, not scope: the RunPod fix and apow-mini hardening are separate workstreams; only M6 touches apow-grind here.
- AWAL research: Coinbase Agentic Wallets launched 2026-02-11; `npx awal` CLI + `coinbase/agentic-wallet-skills` + Payments MCP; email-OTP auth; wallet is a CDP Server Wallet v2 EOA, MPC-split in AWS Nitro Enclave; enclave-enforced spend policies + KYT; gasless on Base; x402-native (`awal x402 pay --max-amount`); operations limited to balance/send/trade/fund/x402 — no arbitrary contract calls or raw signing.
- Landscape: CDP Server Wallets v2 (full API can sign arbitrary EOA txs under TEE policies — viable future `ApowSigner` backend for users, identity-linked so never for project infra); Privy (Stripe-owned) and Turnkey are TEE signers with off-chain policies; Crossmint/thirdweb/Openfort are smart-account-centric (blocked for mining by `tx.origin`); ERC-7715/EIP-7702 do not help mining (policies would live in account code the direct-EOA path bypasses; 4337-style flows fail `tx.origin`).

## Interfaces and Dependencies

- No new runtime dependencies. Use `node:crypto` (sha256 for audit chain), `viem` (`toAccount`, accounts, clients), existing `ox` (keystore), existing `tsx` (tests).
- `@quicknode/x402`: pass `evmSigner: ClientEvmSigner` (`{ address, signTypedData, ... }`) instead of `evmPrivateKey`; keep `paymentModel: "pay-per-request"`.
- `@x402/fetch` + `registerExactEvmScheme(client, { signer })`: accepts the guarded `LocalAccount` directly.
- `@blockrun/clawrouter`: `ProxyOptions.wallet` requires the raw key — the single audited `unsafeRawKeyFor("clawrouter")` consumer; set its per-session max-spend from the remaining daily x402 budget; stop the proxy after mint (existing `stopClawRouter`).
- End-state interfaces that must exist: `src/signer/types.ts` `ApowSigner` (above); `src/policy/policy.ts` `evaluateTx(req): Verdict`, `evaluateTypedData(req): Verdict`, `PolicyDeniedError`; `src/policy/audit-log.ts` `appendAudit(entry)`, `verifyAuditChain(path)`; `src/sweep.ts` `runSweep(opts)`, `maybeAutoSweep(ctx)`; `src/secure-env.ts` `childEnv()`.

Change note (2026-06-10): initial version, authored from the planning session that audited the wallet code, mapped cloud-mining status, and researched AWAL/CDP. Decisions confirmed by AKLO: core protocol with no CDP code; scope = CLI + grind split.
