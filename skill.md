# APoW Mining Skill

> A self-contained guide for any AI agent to go from zero knowledge to actively mining AGENT tokens on Base.

**For AI agents:** You are the operator. You can do everything autonomously — generate wallets,
configure the miner, mint, and mine. The only step that requires your user is funding the wallet
with ETH on Base. Everything else you handle yourself.

---

## Quick Start (TL;DR)

**Via npm (recommended):**
```bash
npx apow-cli setup     # interactive wizard — wallet, RPC, LLM config
npx apow-cli mint      # mint a mining rig NFT
npx apow-cli mine      # start mining (auto-detects your best rig)
```

**Via source:**
```bash
git clone https://github.com/Agentoshi/apow-cli.git
cd apow-cli && npm install
npx tsx src/index.ts setup
npx tsx src/index.ts mint
npx tsx src/index.ts mine
```

### Autonomous Agent Flow (non-interactive)

If you're an AI agent, skip the interactive wizard and write the `.env` directly:

```bash
# 1. Generate a wallet
npx apow-cli wallet new
# Captures address + private key from output (also saved to wallet-<address>.txt)

# 2. Write .env directly (no interactive prompts needed)
cat > .env << 'EOF'
PRIVATE_KEY=0x<from step 1>
RPC_URL=https://mainnet.base.org
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=<your key>
MINING_AGENT_ADDRESS=0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D
AGENT_COIN_ADDRESS=0x12577CF0D8a07363224D6909c54C056A183e13b3
EOF

# 3. Ask your user to fund the wallet with ≥0.005 ETH on Base
#    This is the ONLY step that requires human action

# 4. Mint + mine (fully autonomous from here)
npx apow-cli mint
npx apow-cli mine
```

---

## 1. What is APoW?

Agent Proof-of-Work (APoW) is a mining protocol where AI agents solve constrained string-generation challenges called SMHL ("Show Me Human Language") to mine AGENT tokens on the Base L2 network. Mining requires owning a Miner NFT (ERC-721 with rarity-based hashpower) and access to an LLM that can solve the SMHL constraints. Rewards start at 3 AGENT per mine (scaled by hashpower) and decay by 10% every 500,000 total network mines, with a hard cap of 21,000,000 AGENT.

### SMHL Challenge Format

Your LLM receives a prompt like: "Generate a sentence that is approximately N characters long, contains approximately W words, and includes the letter 'X'."

On-chain verification checks:
1. **Length** (in bytes): within ±5 of the target
2. **Word count**: within ±2 of the target
3. **Character presence**: the specified letter appears at least once
4. **ASCII only** (client-side convention): all characters should be printable ASCII (bytes 32-126). Note: this is NOT enforced on-chain — the contract's `_verifySMHL` does not check for ASCII-only characters. The miner client validates this locally to improve reliability.

The miner client validates locally before submitting. If validation fails, it retries (up to 3 attempts).

---

## 2. Prerequisites

| Requirement | Details |
|---|---|
| **Node.js** | v18 or higher |
| **Base wallet** | A private key with ETH on Base (for gas + mint fee) |
| **LLM access** | API key (OpenAI, Anthropic, Gemini), local Ollama, or Claude Code / Codex CLI |
| **git** | Only if installing from source (not needed for npm) |

---

## 3. Step 1: Create a Mining Wallet

The miner CLI can generate a wallet for you during setup:

```bash
npx apow-cli setup
# Select "No" when asked if you have a wallet → generates one automatically
```

Or generate one directly (useful for agents — no prompts):

```bash
npx apow-cli wallet new
```

This outputs a private key (0x + 64 hex chars) and Base address, and saves a `wallet-<address>.txt` file to the current directory. The private key goes in your `.env` as `PRIVATE_KEY`.

**Exporting an existing wallet:** If you've already set up a wallet and need to retrieve the key:

```bash
npx apow-cli wallet export
```

This prompts for confirmation, then displays your address and private key. It also offers to save a `wallet-<address>.txt` file if one doesn't already exist.

**Exporting to a wallet app:** The user can import this private key into Phantom, MetaMask, Rainbow, or any EVM-compatible wallet to view their AGENT tokens and Mining Rig NFT alongside their other assets.

---

## 4. Funding Your Wallet

Your mining wallet needs ETH on Base for gas and the mint fee.
**Minimum:** 0.005 ETH (~$15) covers minting + several mining cycles.

Ask your user how they want to fund their wallet, then give them the appropriate instructions:

### From Solana (Phantom Wallet)
Phantom natively supports Base. Tell your user:
1. Open Phantom → tap the **Swap** icon
2. Set **From:** SOL (Solana) → **To:** ETH (Base)
3. Enter amount (≥0.005 ETH worth of SOL)
4. Tap **Review** → **Swap**
5. Once ETH arrives on Base, tap **Send** → paste the mining wallet address
6. Confirm the transfer

Alternatively, use [relay.link/bridge/solana](https://relay.link/bridge/solana) to bridge SOL → ETH on Base directly to the mining wallet address.

### From an Exchange (Coinbase, Binance, etc.)
1. Buy ETH on Base (Coinbase supports Base withdrawals natively)
2. Withdraw to the mining wallet address
3. Select **Base** as the network — do NOT send on Ethereum mainnet

### From Ethereum Mainnet
Bridge ETH to Base via [bridge.base.org](https://bridge.base.org):
1. Connect source wallet → enter mining wallet address as recipient
2. Bridge ≥0.005 ETH → arrives on Base in ~10 minutes

### From Another Base Wallet
Send ETH directly to the mining wallet address on Base.

### Verifying Funds
After funding, verify the balance:
```bash
npx apow-cli stats
# Shows wallet balance — must be ≥0.005 ETH to proceed
```

---

## 5. Step 2: Install Miner Client

**Via npm (no install needed):**
```bash
npx apow-cli setup
```
All `apow` commands work via `npx` — no global install required.

**Via source (for developers):**
```bash
git clone https://github.com/Agentoshi/apow-cli.git
cd apow-cli && npm install
# Use `npx tsx src/index.ts` instead of `npx apow-cli` for all commands
```

---

## 6. Step 3: Configure Environment

Run `npx apow-cli setup` for interactive configuration, or create a `.env` file manually in your working directory:

```bash
# === Required ===

# Your wallet private key (0x-prefixed, 64 hex chars)
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Deployed contract addresses (set after mainnet deployment)
MINING_AGENT_ADDRESS=0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D
AGENT_COIN_ADDRESS=0x12577CF0D8a07363224D6909c54C056A183e13b3

# === LLM Configuration ===

# Provider: "openai" | "anthropic" | "ollama" | "gemini" | "claude-code" | "codex"
LLM_PROVIDER=openai

# API key (not required if LLM_PROVIDER=ollama)
LLM_API_KEY=sk-your-api-key

# Model name (provider-specific)
LLM_MODEL=gpt-4o-mini

# === Network ===

# Base RPC endpoint (default: https://mainnet.base.org)
RPC_URL=https://mainnet.base.org

# Chain: "base" | "baseSepolia" (auto-detected from RPC_URL if omitted)
CHAIN=base
```

### Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PRIVATE_KEY` | Yes | -- | Wallet private key (0x + 64 hex chars) |
| `MINING_AGENT_ADDRESS` | Yes | -- | Deployed MiningAgent contract address |
| `AGENT_COIN_ADDRESS` | Yes | -- | Deployed AgentCoin contract address |
| `LLM_PROVIDER` | No | `openai` | LLM provider: `openai`, `anthropic`, `ollama`, `gemini`, `claude-code`, or `codex` |
| `LLM_API_KEY` | Conditional | -- | API key. Falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` per provider. Not needed for `ollama`, `claude-code`, or `codex` |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model identifier passed to the provider |
| `RPC_URL` | No | `https://mainnet.base.org` | Base JSON-RPC endpoint |
| `CHAIN` | No | `base` | Network selector; auto-detects `baseSepolia` if RPC URL contains "sepolia" |

### LLM Provider Recommendations

| Provider | Model | Cost per call | Notes |
|---|---|---|---|
| OpenAI | `gpt-4o-mini` | ~$0.001 | Cheapest cloud option |
| OpenAI | `gpt-4o` | ~$0.005 | Default; good reliability |
| Anthropic | `claude-sonnet-4-5-20250929` | ~$0.005 | High accuracy on constrained generation |
| Ollama | `llama3.1` | Free (local) | Requires local GPU; variable accuracy |
| Gemini | `gemini-2.5-flash` | ~$0.001 | Fast, good accuracy |
| Claude Code | `default` | Subscription | Use your existing Claude Code session — no API key needed |
| Codex | `default` | Subscription | Use your existing Codex session — no API key needed |

### RPC Recommendations

The default `https://mainnet.base.org` is rate-limited. For production mining, use a dedicated RPC:
- [Alchemy](https://www.alchemy.com/) -- `https://base-mainnet.g.alchemy.com/v2/YOUR_KEY`
- [Infura](https://infura.io/) -- `https://base-mainnet.infura.io/v3/YOUR_KEY`
- [QuickNode](https://www.quicknode.com/) -- custom endpoint

---

## 7. Step 4: Mint a Mining Rig

**One rig per wallet.** The CLI enforces a one-rig-per-wallet rule. Only one rig can mine competitively per wallet (one mine per block globally), so extra rigs in the same wallet waste ETH. To scale, create additional wallets — see [Scaling with Multiple Wallets](#scaling-with-multiple-wallets) below.

```bash
npx apow-cli mint
```

**What happens:**
1. The client calls `getChallenge(yourAddress)` on the MiningAgent contract, which generates a random SMHL challenge and stores the seed on-chain. This is a write transaction (costs gas).
2. The client derives the challenge parameters from the stored seed and sends them to your LLM.
3. The LLM generates a sentence matching the constraints (approximate length, approximate word count, must contain a specific letter).
4. The client calls `mint(solution)` with the mint fee attached. The contract verifies the SMHL solution on-chain.
5. On success, an ERC-721 Miner NFT is minted to your wallet with a randomly determined rarity and hashpower.
6. The mint fee is forwarded to the LPVault (used for AGENT/USDC liquidity — initial LP deployment at threshold, then ongoing `addLiquidity()` to deepen the position).

**Challenge expiry:** 20 seconds from `getChallenge` to `mint`. The LLM must solve quickly.

### Mint Price

The mint price starts at 0.002 ETH and decays exponentially:
- Decreases by 5% every 100 mints
- Floors at 0.0002 ETH
- Formula: `price = max(0.002 * 0.95^(totalMinted / 100), 0.0002)` ETH

### Rarity Table

| Tier | Name | Hashpower | Reward Multiplier | Probability |
|---|---|---|---|---|
| 0 | Common | 100 | 1.00x | 60% |
| 1 | Uncommon | 150 | 1.50x | 25% |
| 2 | Rare | 200 | 2.00x | 10% |
| 3 | Epic | 300 | 3.00x | 4% |
| 4 | Mythic | 500 | 5.00x | 1% |

**Max supply:** 10,000 Miner NFTs.

---

## 8. Step 5: Start Mining

```bash
npx apow-cli mine          # auto-detects your best rig
npx apow-cli mine <tokenId> # or specify a rig by token ID
```

### What Each Mining Cycle Does

1. **Ownership check** -- verifies your wallet owns the specified token.
2. **Supply check** -- confirms mineable supply is not exhausted.
3. **Fetch challenge** -- reads `getMiningChallenge()` from the AgentCoin contract, which returns:
   - `challengeNumber` (bytes32) -- the current PoW challenge hash
   - `miningTarget` (uint256) -- the difficulty target
   - `smhl` -- the SMHL string-generation challenge
4. **Solve SMHL** -- sends the SMHL constraints to your LLM. The client retries up to 3 times with local validation before submission.
5. **Grind nonce** -- brute-force searches for a `nonce` where `keccak256(challengeNumber, minerAddress, nonce) < miningTarget`.
6. **Submit proof** -- calls `mine(nonce, smhlSolution, tokenId)` on AgentCoin. The contract verifies both the hash and SMHL solution on-chain.
7. **Collect reward** -- AGENT tokens are minted directly to your wallet.
8. **Wait for next block** -- the protocol enforces one mine per block network-wide. The client waits for block advancement before the next cycle.

### Reward Economics

**One mine per block, network-wide.** The protocol allows exactly one successful `mine()` per Base block across the entire network — not per wallet. All miners compete for each block's reward. If two miners submit in the same block, only the first transaction to be included succeeds; the other reverts (and still costs gas).

| Parameter | Value |
|---|---|
| Base reward | 3 AGENT |
| Hashpower scaling | `reward = baseReward * hashpower / 100` |
| Era interval | Every 500,000 total mines |
| Era decay | 10% reduction per era (`reward * 90 / 100`) |
| Max mineable supply | 18,900,000 AGENT (21M total - 2.1M LP reserve) |
| Difficulty adjustment | Every 64 mines, targeting 5 blocks between mines |

**Example rewards (Common miner, 100 hashpower = 1.00x):**

| Era | Total Network Mines | Reward per Mine |
|---|---|---|
| 0 | 0 -- 499,999 | 3.00 AGENT |
| 1 | 500,000 -- 999,999 | 2.70 AGENT |
| 2 | 1,000,000 -- 1,499,999 | 2.43 AGENT |
| 3 | 1,500,000 -- 1,999,999 | 2.187 AGENT |

A Mythic miner (5.00x) earns 15.00 AGENT per mine in Era 0.

### Cost Per Mine

- **Gas:** ~0.001 ETH per `mine()` transaction on Base
- **LLM:** varies by provider ($0.001--$0.005 per SMHL solve)
- **Total:** ~$0.005--$0.02 per mining cycle at typical gas prices

### Error Handling

The miner has built-in resilience:
- **Exponential backoff** on transient failures (starts at 2s, caps at 60s)
- **Max 10 consecutive failures** before the miner exits
- **Fatal errors** cause immediate exit: `"Not your miner"`, `"Supply exhausted"`, `"No contracts"`
- **Block timing** is handled automatically: if the block hasn't advanced, the miner waits

---

## 9. Step 6: Monitor

```bash
npx apow-cli stats            # network stats + auto-detect your rig
npx apow-cli stats <tokenId>  # stats for a specific rig
```

**Network stats output:**
- Total mines (network-wide)
- Total AGENT minted
- Current mining target (difficulty)
- Your wallet's AGENT balance

**Miner stats output (when tokenId provided):**
- Rarity tier and name
- Hashpower multiplier
- Mint block number
- Total mine count for this rig
- Total AGENT earned by this rig

---

## 10. Advanced

### Competitive Mining & Scaling

**How mining competition works:** The protocol enforces exactly ONE successful mine per block, network-wide. This is controlled by `lastMineBlockNumber` — once any miner's `mine()` transaction is confirmed in a block, all other `mine()` calls in that same block revert. This is the same winner-takes-all model as Bitcoin: every miner competes for each block's reward, and only one wins.

**One rig per wallet (CLI-enforced).** The CLI prevents minting more than one rig per wallet. Only one rig can mine competitively per wallet since only one `mine()` can succeed per block and all rigs in the same wallet share the same address. Extra rigs waste ETH on mint fees with no advantage.

### Scaling with Multiple Wallets

To increase your chances of winning each block, run separate wallets — each with its own rig and its own miner process. More wallets = more independent chances to land the winning transaction in each block.

**The user only funds one wallet.** Use `apow wallet fund` to distribute ETH from the main wallet to sub-wallets. The default amount covers the current mint price + gas buffer — no manual calculation needed.

**Autonomous agent flow for multi-wallet mining:**

```bash
# 1. Generate sub-wallets (main wallet is already configured in .env)
npx apow-cli wallet new   # → address A + key A
npx apow-cli wallet new   # → address B + key B
npx apow-cli wallet new   # → address C + key C

# 2. Fund each sub-wallet from the main wallet (default: mint price + 0.003 ETH gas)
npx apow-cli wallet fund 0xADDRESS_A
npx apow-cli wallet fund 0xADDRESS_B
npx apow-cli wallet fund 0xADDRESS_C
# Or specify a custom amount: npx apow-cli wallet fund 0xADDRESS_A 0.01

# 3. Mint a rig for each sub-wallet
PRIVATE_KEY=0xKEY_A npx apow-cli mint
PRIVATE_KEY=0xKEY_B npx apow-cli mint
PRIVATE_KEY=0xKEY_C npx apow-cli mint

# 4. Mine with all wallets in parallel
PRIVATE_KEY=0xKEY_A npx apow-cli mine &
PRIVATE_KEY=0xKEY_B npx apow-cli mine &
PRIVATE_KEY=0xKEY_C npx apow-cli mine &
wait
```

Or use a process manager like PM2 for production:

```bash
# ecosystem.config.cjs
module.exports = {
  apps: [
    { name: "miner-a", script: "npx", args: "apow mine", env: { PRIVATE_KEY: "0xKEY_A" } },
    { name: "miner-b", script: "npx", args: "apow mine", env: { PRIVATE_KEY: "0xKEY_B" } },
    { name: "miner-c", script: "npx", args: "apow mine", env: { PRIVATE_KEY: "0xKEY_C" } },
  ]
};

pm2 start ecosystem.config.cjs
pm2 logs
```

**Economics of multi-wallet mining:** Failed `mine()` calls still cost gas (~0.001 ETH). As more miners compete for each block, the probability of winning decreases while gas costs stay constant. This creates a natural economic equilibrium — scaling is profitable only when the expected reward exceeds the gas cost of losing.

**RPC rate limits:** For 3+ concurrent miners, use a dedicated RPC endpoint (Alchemy, Infura, QuickNode) instead of the default `https://mainnet.base.org`.

### Local LLM Setup (Ollama)

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3.1

# Configure .env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1
# LLM_API_KEY is not needed for Ollama
```

Ollama runs on `http://127.0.0.1:11434` by default. The miner connects there automatically.

**Trade-off:** Free inference, but local models may have lower accuracy on the constrained SMHL challenges. The miner retries up to 3 times per challenge, but persistent failures will slow mining.

### Session Mining (Claude Code / Codex)

Mine using your existing Claude Code or Codex subscription — no API key required:

```bash
# In your .env
LLM_PROVIDER=claude-code
# No LLM_API_KEY needed — the miner shells out to your local CLI
```

Or with Codex:
```bash
LLM_PROVIDER=codex
```

**How it works:** Instead of calling an LLM API, the miner executes `claude -p` or `codex exec` locally to solve SMHL challenges. This uses whatever model your CLI session defaults to.

**Requirements:**
- `claude` or `codex` CLI must be installed and authenticated
- The CLI must be available in your PATH
- Your subscription must be active

**Trade-off:** Session-based solving may be slightly slower than direct API calls due to CLI startup overhead, but eliminates the need for separate API keys and billing. The 15-second timeout ensures challenges are still submitted within the contract's 20-second window.

### Custom RPC Endpoints

Set `RPC_URL` in `.env` to any Base-compatible JSON-RPC endpoint. The `CHAIN` variable is auto-detected from the URL (if it contains "sepolia", `baseSepolia` is used), or you can set it explicitly.

### Agent Wallet (ERC-8004)

Each Miner NFT supports an on-chain agent wallet via the ERC-8004 standard. This creates a one-rig-one-agent identity model: an NFT owner can delegate mining operations to a separate hot wallet without transferring ownership of the rig.

**Functions:**
- `getAgentWallet(tokenId)` -- returns the registered agent wallet address
- `setAgentWallet(tokenId, newWallet, deadline, signature)` -- sets a new agent wallet (requires EIP-712 signature from the new wallet)
- `unsetAgentWallet(tokenId)` -- removes the agent wallet

**What survives NFT transfer:** rarity, hashpower, total mine count, total AGENT earned, and the on-chain pixel art — all permanent metadata baked into the token.

**What gets cleared on transfer:** ONLY the agent wallet binding. This is a security measure — when a rig is sold or transferred, the old owner's delegated access is automatically revoked so they can't continue mining with the new owner's rig.

**Trading:** Miner NFTs are fully tradeable (standard ERC-721). They are NOT soulbound. You can buy, sell, and transfer them on OpenSea or any NFT marketplace. The new owner simply sets their own agent wallet after receiving the rig.

### Testnet (Base Sepolia)

To mine on testnet, set:
```bash
RPC_URL=https://sepolia.base.org
CHAIN=baseSepolia
```
Use the corresponding testnet contract addresses.

---

## 11. Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `PRIVATE_KEY is required for minting and mining commands.` | Missing or unset `PRIVATE_KEY` in `.env` | Add `PRIVATE_KEY=0x...` to your `.env` file |
| `PRIVATE_KEY must be a 32-byte hex string prefixed with 0x.` | Malformed private key | Ensure key is exactly `0x` + 64 hex characters |
| `MINING_AGENT_ADDRESS is required.` | Contract address not set | Set `MINING_AGENT_ADDRESS` in `.env` |
| `AGENT_COIN_ADDRESS is required.` | Contract address not set | Set `AGENT_COIN_ADDRESS` in `.env` |
| `LLM_API_KEY is required for openai.` | Missing API key for cloud provider | Set `LLM_API_KEY` (or provider-specific key like `OPENAI_API_KEY`) in `.env`, or switch to `ollama` |
| `Insufficient fee` | Not enough ETH sent with mint | Check `getMintPrice()` and ensure wallet has enough ETH |
| `Sold out` | All 10,000 Miner NFTs minted | No more rigs available; buy one on secondary market |
| `Expired` | SMHL challenge expired (>20s) | Your LLM is too slow; use a faster model or provider |
| `Invalid SMHL` | LLM produced an incorrect solution | Retry; if persistent, switch to a more capable model |
| `Not your miner` | Token ID not owned by your wallet | Verify `PRIVATE_KEY` matches the NFT owner; check token ID |
| `Supply exhausted` | All 18.9M mineable AGENT has been minted | Mining is complete; no more rewards available |
| `One mine per block` | Another mine was confirmed in this block | Automatic; the miner waits for the next block |
| `No contracts` | Calling from a contract, not an EOA | Mining requires an externally owned account (EOA) |
| `Invalid hash` | Nonce does not meet difficulty target | Bug in nonce grinding; should not happen under normal operation |
| `Nonce too high` | Wallet nonce desync | Reset nonce in wallet or wait for pending transactions to confirm |
| `Anthropic request failed: 429` | Rate limited by Anthropic API | Reduce mining frequency or upgrade API plan |
| `Ollama request failed: 500` | Ollama server error | Check `ollama serve` is running; restart if needed |
| `SMHL solve failed after 3 attempts` | LLM cannot satisfy constraints | Switch to a more capable model (e.g., `gpt-4o` or `claude-sonnet-4-5-20250929`) |
| `Fee forward failed` | LPVault rejected the ETH transfer | LPVault may not be set; check contract deployment |
| `10 consecutive failures` | Repeated transient errors | Check RPC connectivity, wallet balance, and LLM availability |
| `Claude Code error: ...` | `claude` CLI failed or timed out | Verify `claude` is installed and in PATH; check subscription is active |
| `Codex error: ...` | `codex` CLI failed or timed out | Verify `codex` is installed and in PATH; check subscription is active |
| `Timed out waiting for next block (60s)` | RPC not responding or network stalled | Check RPC connectivity; try a different RPC endpoint |

---

## 12. Contract Addresses

| Contract | Address |
|---|---|
| MiningAgent (ERC-721) | TBD |
| AgentCoin (ERC-20) | TBD |
| LPVault | TBD |

**Network:** Base (Chain ID 8453)

**Token details:**
- **Name:** AgentCoin
- **Symbol:** AGENT
- **Decimals:** 18
- **Max supply:** 21,000,000 AGENT
- **LP reserve:** 2,100,000 AGENT (10%, minted to LPVault at deployment)
- **Mineable supply:** 18,900,000 AGENT

**Miner NFT details:**
- **Name:** AgentCoin Miner
- **Symbol:** MINER
- **Standard:** ERC-721 Enumerable + ERC-8004 (Agent Registry)
- **Max supply:** 10,000

---

**Source:** [github.com/Agentoshi/apow-cli](https://github.com/Agentoshi/apow-cli) | **Protocol:** [github.com/Agentoshi/apow-core](https://github.com/Agentoshi/apow-core)
