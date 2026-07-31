---
name: apow-mining
description: This skill teaches your agent how to mine $AGENT coin via the apow-cli.
allowed-tools: Bash(npx --yes apow-cli@0.12.0 start --easy)
metadata:
  openclaw:
    requires:
      anyBins:
        - npx
---

# APoW Mining

Use this skill only to set up a fresh APoW mining wallet and run the official APoW miner. It is deliberately limited to that workflow.

APoW mining uses real assets on Base. Use a fresh, low-balance hot wallet dedicated to APoW. The CLI stores generated wallets as password-protected JSON keystores and applies a local signing policy with spend caps.

## Required approval

Before running the miner, show the user this scope and wait for an explicit approval:

> Approve APoW to create or use one fresh encrypted low-balance wallet; spend up to the local policy caps for one rig mint and x402 RPC, SMHL, and grinding services; submit Base mining transactions continuously until stopped; and sweep mined AGENT only if a payout address and automatic sweep were already configured?

Do not infer approval from funding, installation, prior mining, or a general request to inspect the project. Run the command only after the user approves the scope above.

Once approved, select the CLI's existing Easy Mode with the pinned package:

```bash
npx --yes apow-cli@0.12.0 start --easy
```

Funding is a mandatory external prerequisite: the CLI cannot mint or mine until
the dedicated wallet has ETH and USDC on Base. The same command handles the two
phases around that checkpoint:

- before funding, it creates an encrypted APoW wallet if needed, configures Easy
  Mode, prints the complete Base address and required balances, then stops;
- after the user funds that address and confirms funding, rerunning it detects
  an existing rig or mints one within the configured cap, starts continuous
  mining, retries normal transient failures, and keeps signing behind the local
  enforce-mode policy.

The user's approval authorizes this Easy Mode invocation; Wallet Protocol v2 remains the sole runtime opsec and signing-policy layer. The user can stop mining with Ctrl+C.

## Funding handoff

If the CLI pauses because the wallet needs funds:

1. Return the complete Base wallet address and the ETH and USDC minimums printed by the CLI.
2. Tell the user to send those assets to that address on Base.
3. Stop. Do not move, convert, or source funds for the user.
4. After the user confirms funding, resume the same Easy Mode flow with the pinned `start --easy` command.

Funding is a handoff, not permission to operate another wallet or move assets.

## Security boundaries

- Never request, read, reveal, copy, or transmit wallet secrets.
- Never search files, directories, environment variables, shell history, mounted drives, or other machines for wallets or credentials.
- Never import or operate a main wallet for this skill.
- Never create a raw-key file or place a raw wallet secret in project configuration.
- Invoke only the single pinned `start --easy` command in this skill; every other CLI command is out of scope.
- Never change the signing policy from `enforce`.
- Never raise the mint, transfer, sweep, or x402 spend caps.
- Never install or execute an unpinned package version.
- Never continue if the package version, contract addresses, chain, approval scope, or policy state differs from what the CLI displays.

If setup asks for a keystore password, the user must enter it directly into their local terminal or provide it through their own secret manager. Never ask them to paste it into chat.

## Expected policy caps

The default enforce-mode policy limits:

- one rig mint to at most `0.01 ETH`;
- each x402 payment to at most `1 USDC`;
- aggregate x402 payments to at most `20 USDC` per UTC day;
- transfers and sweeps to their separately configured destinations and caps.

Treat the CLI’s displayed policy as authoritative. If it is less restrictive than these defaults, stop and ask the user to review it.

## Failure handling

- No wallet: allow `start` to create one encrypted APoW wallet.
- Password unavailable: pause for direct local entry; do not handle it in chat.
- Funding needed: use the Base-only handoff above.
- Policy not in enforce mode: stop.
- User approval for the scoped Easy Mode command missing: stop.
- Package version unavailable: stop; do not substitute `latest`.
- RPC, SMHL, grinder, or transaction failure: report the concise error and let the CLI’s bounded retry behavior handle transient failures.
- Mining stopped: report whether the user interrupted it or the CLI exited with an error.

Do not expand scope to “helpful” wallet operations. This skill’s complete job is the existing Easy Mode flow: encrypted APoW setup, a Base funding handoff, and policy-capped mining.
