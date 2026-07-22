# APoW CLI — ETH-Only Funding ("full ETH gas solve")

This is a self-contained ExecPlan per `~/.codex/PLANS.md`. An implementer with only the apow-cli working tree and this file can execute it end to end.

## Purpose / Big Picture

Funding the mining wallet is the worst part of the apow-cli UX today. A user generated a wallet, reached the funding step, and the CLI sat for 10 minutes polling for a **USDC** deposit it never actually needed, then failed with "No USDC deposit detected." The user reasonably expected to send ETH (or any asset) and have it just work.

The protocol truth: **ETH is the only thing you truly need.** Base charges gas in ETH, and the Mining Rig mint price is paid in ETH. USDC is needed *only* for opt-in "x402" pay-per-call services (QuickNode x402 RPC, ClawRouter x402 LLM, x402 GPU grind). If a user brings their own RPC (e.g. Alchemy) and uses a local LLM + local grinder, they need **zero USDC**.

After this change, funding is **ETH-first and forgiving**:

- The user funds with **ETH** — sent directly on Base, or bridged from **Solana** or **Ethereum mainnet** (both kept).
- The **"send USDC directly on Base" option is removed.** USDC is never something the user is asked to send.
- Everything **converges to ETH** on Base. If a source lands USDC (e.g. a Solana-USDC bridge), the CLI swaps it to ETH automatically.
- USDC is only ever acquired when an x402 service is actually configured, and then it is **auto-bought from the user's ETH** via Uniswap — the user still only ever sends ETH.
- The deposit watcher accepts **whatever arrives** (ETH or USDC) instead of polling one hardcoded token and timing out.

Observable outcome: with a local-LLM + local-grinder + own-RPC config, `apow start` → fund screen says "Send ~0.005 ETH to <address>" → user sends ETH → it is detected within seconds → mint → mine, with **no USDC prompt anywhere**. With an x402 service configured, the user still only sends ETH, and the CLI buys the small USDC amount it needs.

## Progress

- [x] (2026-06-19) M1: `usdcRequired(config)` in `src/config.ts` covers x402 RPC, x402 grind, AND clawrouter LLM. Unit-tested (`src/funding-policy.test.ts`, 4 cases).
- [x] (2026-06-19) M2: Direct Base-USDC removed — `selectSourceToken` returns `native` for base; menu reads "Base (send ETH)"; `runFundFlow` forces base→native; headless examples drop `--chain base --token usdc`. Solana + Ethereum bridges kept.
- [x] (2026-06-19) M3: Bridges converge to ETH (Solana-USDC route now `sol_usdc_to_eth` → ETH on Base, no on-Base swap); `autoSplit` early-returns for ETH-only setups and only buys USDC (ETH→USDC) when `usdcRequired`. Start-flow `needsUsdc` + banner use `usdcRequired`.
- [x] (2026-06-19) M4: `runBaseFund` is ETH-only and forgiving — polls ETH, and if USDC shows up with no ETH it says so (no silent 10-min dead end).
- [ ] M5: Wizard Mint-AI menu labels the funding implication ("ClawRouter — needs USDC, auto-bought from ETH" vs "Local — ETH only, free"). Remaining.
- [ ] M6 (partial): unit tests for `usdcRequired` done; README/skill.md funding section + synced copies still to update. Solana/Ethereum bridge paths need a live `SQUID_INTEGRATOR_ID` to smoke-test.

## Surprises & Discoveries

- The start flow's USDC detection is technically correct but incomplete: `needsUsdc = config.useX402 && ...` (`src/index.ts:537`) ignores `useX402Grind` and `llmProvider === "clawrouter"`. With clawrouter selected and Alchemy RPC, `useX402` is false so the start flow thinks no USDC is needed — yet minting with clawrouter *does* spend USDC at solve time. So the flag both over-asks (interactive menu offers USDC) and under-detects (misses clawrouter). One `usdcRequired()` helper fixes both directions.
  Evidence: `src/index.ts:536-537`, `src/config.ts:222-229`, ClawRouter is an x402 LLM that pays USDC per solve.
- The actual dead-end: `selectSourceToken()` (`src/fund.ts:~544`) offers "1. ETH / 2. USDC" for the Base chain, and the funding banner (`fund.ts:~613-617`) always prints both ETH and USDC minimums — so the user picked USDC, and `runBaseFund()` (`fund.ts:456-525`) polled **only** USDC balance for 600s then failed (`fund.ts:518`).
- `src/bridge/uniswap.ts` only has `swapEthToUsdc` / `swapUsdcToEth` — there is **no** generic "any token → ETH" swap. So true "accept any arbitrary token" is out of scope; ETH + USDC + Solana/Ethereum bridges cover the real cases.

## Decision Log

- Decision: Funding target is always ETH; USDC is auto-bought from ETH only when `usdcRequired(config)` is true.
  Rationale: ETH is the only protocol-mandated asset (gas + mint price). USDC is an opt-in x402 detail the user should never have to source themselves.
  Date/Author: 2026-06-19 / Claude (planning).
- Decision: Remove the "send USDC directly on Base" menu option entirely; keep the Solana and Ethereum-mainnet bridge options.
  Rationale: explicit user instruction ("keep our solana deposit option AND mainnet eth option … just no base USDC directly").
- Decision: Keep the Solana-USDC bridge *source* route, but converge its Base output to ETH (swap USDC→ETH on arrival).
  Rationale: "keep solana deposit option" includes funding from Solana USDC; the result must still land as ETH under the ETH-first model.
- Decision: Do not add arbitrary-ERC20 → ETH swapping.
  Rationale: only ETH↔USDC Uniswap routes exist; arbitrary-token liquidity/routing is a separate, larger feature and not what was asked.

## Context and Orientation

Workspace: `/Users/aklo/projects/apow/apow-cli` (TypeScript mining CLI, viem). Build `npm run build`, test `npm test`, run `node dist/index.js <cmd>`.

Key files and current behavior:

- `src/fund.ts` — funding orchestrator.
  - `runFundFlow(opts)` (`:580`) — entry; interactive menus when no chain/token given. Dispatches: solana → `runSolanaFund`, ethereum → `runEthereumFund`, base → `runBaseFund`.
  - `selectSourceChain()` (`:~531`) and `selectSourceToken(chain)` (`:~544`) — interactive menus. `selectSourceToken` currently offers native vs USDC.
  - `runBaseFund(addr, sourceToken, noSwap)` (`:456`) — prints the address, polls **one** token's balance for 600s (`:493-515`), fails at `:518`, then `autoSplit`.
  - `runSolanaFund(addr, token, targetEth)` (`:226`) — Squid bridge SOL→ETH or Solana-USDC→Base-USDC, polls source, then `autoSplit`.
  - `runEthereumFund(addr, targetEth)` (`:353`) — Squid bridge mainnet ETH→Base ETH, then `autoSplit("eth", …)`.
  - `autoSplit(depositedAsset, prices, noSwap)` (`:100`) — swaps ETH→USDC if `usdc < MIN_USDC`, or USDC→ETH if `eth < MIN_ETH`. Always tries to satisfy BOTH minimums.
- `src/index.ts` — `runStartFlow()` (`:475`): computes `needsEth` / `needsUsdc` (`:536-537`), shows a table, prompts "Run funding flow now?", calls `runFundFlow({})` (`:560`). Also the setup wizard (`setupWizard`, Mint-AI menu) lives here.
- `src/bridge/constants.ts` — `MIN_ETH = 0.003`, `MIN_USDC = 2.0`, `SLIPPAGE_BPS = 200`; types `SourceChain = "solana"|"ethereum"|"base"`, `SourceToken = "native"|"usdc"`, `BaseAsset = "eth"|"usdc"`; `bridgeOutputAsset(token)`.
- `src/bridge/squid.ts` — `SQUID_ROUTES` (`sol_to_eth`, `sol_usdc_to_base_usdc`, `eth_to_base_eth`), `getDepositAddress`, `pollBridgeStatus`. Keep all routes.
- `src/bridge/uniswap.ts` — `getUsdcBalance`, `swapEthToUsdc(ethWei, minUsdc)`, `swapUsdcToEth(usdcRaw, minEth)`. ETH↔USDC only.
- `src/config.ts` — `AppConfig` has `useX402`, `useX402Grind`, `llmProvider`. `useX402 = process.env.USE_X402 === "true"` (`:224`). No combined USDC flag.
- `src/mint.ts` — `runMintFlow` checks only ETH (mint price + gas); no USDC pre-check (clawrouter spends USDC at solve time without a guard).

Definitions: "x402" = an HTTP pay-per-call protocol where the wallet pays USDC per request (QuickNode RPC, ClawRouter LLM, grind.apow.io GPU). "converge to ETH" = ensure the Base wallet ends with at least the ETH target, swapping any landed USDC to ETH.

## Plan of Work

**M1 — One source of truth for USDC need.** Add `export function usdcRequired(c = config): boolean` in `src/config.ts` returning `c.useX402 || c.useX402Grind || c.llmProvider === "clawrouter"`. Replace `src/index.ts:537` `needsUsdc` to use it. Any future x402 service joins this one helper.

**M2 — Base path is ETH-only; bridges kept.** In `src/fund.ts`:
- `selectSourceToken(chain)`: for `chain === "base"`, return `"native"` unconditionally (no USDC prompt) — there is no longer a direct-Base-USDC option. For `chain === "solana"`, still allow native(SOL)/USDC as the *source* (both bridge in). For `chain === "ethereum"`, native only (unchanged).
- Update `runFundFlow` headless examples / hints (`:47-57`) to drop `apow fund --chain base --token usdc`.
- Funding banner in `runBaseFund` (`:463-478`): ETH-only copy ("Send ETH from any wallet — Coinbase, MetaMask, Phantom…"). No USDC line.

**M3 — Converge to ETH; buy USDC only if required.** Replace `autoSplit` with `convergeToEth(landedAsset, prices, opts)`:
- Always ensure `ethBalance >= MIN_ETH` (plus a small mint buffer). If short and `usdcBalance` exists, swap USDC→ETH (`swapUsdcToEth`) to top up.
- If `usdcRequired(config)` and `usdcBalance < MIN_USDC`: swap a slice of ETH→USDC (`swapEthToUsdc`) to reach `MIN_USDC`, keeping ≥ `MIN_ETH` ETH in reserve. Otherwise do nothing with USDC.
- Solana/Ethereum bridge paths and the Base path all call `convergeToEth` after the deposit lands.

**M4 — Forgiving deposit watcher.** In `runBaseFund`, poll for an increase in **either** ETH or USDC balance (not one hardcoded token). Whatever arrives, stop the spinner ("Deposit received: X ETH" / "X USDC") and hand to `convergeToEth`. This removes the single-token 10-minute dead end. (Bridges keep their existing source-side polling + `pollBridgeStatus`.)

**M5 — Wizard clarity.** In `setupWizard` Mint-AI menu (`src/index.ts`), append the funding implication to each option so nobody is surprised: `1. ClawRouter — needs USDC (auto-bought from your ETH)`, `4. Local — ETH only, free`. Keep all choices (per prior user feedback); just label them.

**M6 — Docs + tests.** Update the funding sections of `README.md` and `skill.md` (and synced skill copies) to "fund with ETH; bridge from Solana/Ethereum; USDC auto-handled for x402." Add `src/config.test.ts` (or extend an existing suite) asserting `usdcRequired` truth table, and a unit test for the converge math (pure helper extracted from `convergeToEth`).

## Concrete Steps

From `/Users/aklo/projects/apow/apow-cli`, work on a branch:

    git checkout -b feature/eth-only-funding

Implement M1–M6 in the files above. Then:

    npm run build            # expect: clean tsc
    npm test                 # expect: all pass incl. new usdcRequired/converge tests
    npm pack --dry-run       # expect: no test files, includes dist/

Manual mainnet smoke (real ETH, ~0.005 on Base) on a throwaway wallet:

    node dist/index.js setup    # Advanced, Alchemy RPC, Mint AI = Local, grinder = Local
    node dist/index.js start    # fund screen must say ETH only; send ETH; detected in seconds; mints; mines

## Validation and Acceptance

- With own-RPC + local LLM + local grinder: `apow start` funding screen mentions **only ETH**, never prompts USDC; sending ETH is detected within ~one poll cycle; flow proceeds to mint. (Before: it could sit 10 min waiting for USDC.)
- With an x402 service configured (e.g. `LLM_PROVIDER=clawrouter`): funding screen still asks only for ETH; after ETH lands, the CLI auto-swaps a slice to USDC (≥ `MIN_USDC`) and proceeds; the user is never asked to send USDC.
- Sending **USDC** to the address anyway is detected and converted to ETH (no dead-end).
- Solana and Ethereum bridge options still appear and still work (Squid routes unchanged); their output converges to ETH.
- No menu path offers "send USDC directly on Base."
- `npm test` passes; `usdcRequired` truth table verified.

## Idempotence and Recovery

All work on `feature/eth-only-funding`; the live tree is unaffected until merged. Re-running setup/fund is safe (no destructive on-chain action without explicit user send). Rollback = `git checkout main`. No contract or deploy changes — CLI only.

## Interfaces and Dependencies

- `src/config.ts`: add `export function usdcRequired(c?: AppConfig): boolean`.
- `src/fund.ts`: `convergeToEth(landed: BaseAsset, prices: PriceInfo, opts: { noSwap?: boolean }): Promise<void>` replaces `autoSplit`; `runBaseFund` watches ETH|USDC; `selectSourceToken` returns `"native"` for base.
- Reuse `swapEthToUsdc`, `swapUsdcToEth`, `getUsdcBalance` (`src/bridge/uniswap.ts`) and the existing Squid routes (`src/bridge/squid.ts`) unchanged.
