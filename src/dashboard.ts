import * as http from "node:http";
import { createPublicClient, formatEther, getAddress, http as viemHttp, type Abi, type Address, type Transport } from "viem";
import type { LocalAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getDashboardHtml } from "./dashboard-html";
import { loadGeneratedWalletAddresses } from "./wallet-store";
import { createX402Transport } from "./x402";

import AgentCoinAbiJson from "./abi/AgentCoin.json";
import MiningAgentAbiJson from "./abi/MiningAgent.json";

const AgentCoinAbi = AgentCoinAbiJson as Abi;
const MiningAgentAbi = MiningAgentAbiJson as Abi;

const RARITY_LABELS = ["Common", "Uncommon", "Rare", "Epic", "Mythic"] as const;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const DEFAULT_RPC = ""; // No default public RPC — user must set RPC_URL or USE_X402

// --- Types ---

interface MinerData {
  tokenId: string;
  rarity: number;
  rarityLabel: string;
  hashpower: number;
  mineCount: string;
  earnings: string;
  mintBlock: string;
  imageUri?: string;
}

interface WalletData {
  address: string;
  ethBalance: string;
  agentBalance: string;
  miners: MinerData[];
}

export interface DashboardOpts {
  port: number;
  rpcUrl: string;
  useX402: boolean;
  signer?: LocalAccount;
  miningAgentAddress: Address;
  agentCoinAddress: Address;
}

// --- Wallet loading ---

function normalizeAddress(s: string): Address | null {
  if (!ADDR_RE.test(s)) return null;
  return getAddress(s.toLowerCase()) as Address;
}

function getWalletAddresses(): Address[] {
  return loadGeneratedWalletAddresses().flatMap((address) => normalizeAddress(address) ?? []);
}

// --- Art parsing ---

function parseArtFromTokenUri(raw: string): string {
  if (!raw?.startsWith("data:application/json;base64,")) return "";
  try {
    const json = JSON.parse(Buffer.from(raw.slice(29), "base64").toString("utf8"));
    return json.image ?? "";
  } catch {
    return "";
  }
}

// --- Server ---

export function startDashboardServer(opts: DashboardOpts): http.Server {
  const { port, rpcUrl, useX402, signer, miningAgentAddress, agentCoinAddress } = opts;

  const transport: Transport = useX402 && signer
    ? createX402Transport(signer)
    : viemHttp(rpcUrl);

  const publicClient = createPublicClient({
    chain: base,
    transport,
  });

  const artCache = new Map<string, string>();
  const htmlPage = getDashboardHtml();

  // Response cache with TTL. Manual refreshes wait for fresh stale data instead of
  // returning old values and silently updating after the UI has already rendered.
  const responseCache = new Map<string, { data: string; ts: number }>();
  const pendingFetches = new Map<string, Promise<string>>();
  const CACHE_TTL = 25_000;

  async function cachedHandler(key: string, handler: () => Promise<string>): Promise<string> {
    const cached = responseCache.get(key);
    const now = Date.now();
    const isStale = !cached || (now - cached.ts > CACHE_TTL);

    if (isStale && !pendingFetches.has(key)) {
      const fetchPromise = handler()
        .then((result) => {
          responseCache.set(key, { data: result, ts: Date.now() });
          pendingFetches.delete(key);
          return result;
        })
        .catch((err) => {
          pendingFetches.delete(key);
          if (cached) return cached.data;
          throw err;
        });
      pendingFetches.set(key, fetchPromise);
    }

    // Stale manual refreshes should wait for the in-flight read so the button
    // actually returns current balances.
    if (isStale && pendingFetches.has(key)) {
      return pendingFetches.get(key)!;
    }

    return cached ? cached.data : "{}";
  }

  // Chunked multicall — split large batches to avoid RPC limits
  type McContract = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
  const MULTICALL_CHUNK = 30; // max calls per multicall batch
  async function chunkedMulticall(contracts: McContract[]): Promise<{ status: string; result?: unknown; error?: unknown }[]> {
    if (contracts.length <= MULTICALL_CHUNK) {
      return publicClient.multicall({ contracts });
    }
    const results: { status: string; result?: unknown; error?: unknown }[] = [];
    for (let i = 0; i < contracts.length; i += MULTICALL_CHUNK) {
      const chunk = contracts.slice(i, i + MULTICALL_CHUNK);
      try {
        const chunkResults = await publicClient.multicall({ contracts: chunk });
        results.push(...chunkResults);
      } catch {
        for (let j = 0; j < chunk.length; j++) {
          results.push({ status: "failure" });
        }
      }
    }
    return results;
  }

  async function handleWallets(): Promise<string> {
    const addresses = getWalletAddresses();
    if (addresses.length === 0) return "[]";

    // Phase 1: ETH balance + AGENT balance + NFT count (chunked)
    const phase1Contracts = addresses.flatMap((addr) => [
      { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "balanceOf" as const, args: [addr] },
      { address: miningAgentAddress, abi: MiningAgentAbi, functionName: "balanceOf" as const, args: [addr] },
    ]);

    const [balances, multicallResults] = await Promise.all([
      Promise.all(addresses.map((addr) => publicClient.getBalance({ address: addr }).catch(() => 0n))),
      chunkedMulticall(phase1Contracts),
    ]);

    const walletInfos = addresses.map((addr, i) => ({
      address: addr,
      ethBalance: balances[i],
      agentBalance: (multicallResults[i * 2]?.result as bigint) ?? 0n,
      nftCount: Number((multicallResults[i * 2 + 1]?.result as bigint) ?? 0n),
    }));

    // Phase 2: token IDs (chunked)
    const tokenIdContracts: { address: Address; abi: Abi; functionName: string; args: [Address, bigint] }[] = [];
    const tokenIdMap: { walletIdx: number }[] = [];

    for (let wi = 0; wi < walletInfos.length; wi++) {
      const info = walletInfos[wi];
      for (let mi = 0; mi < info.nftCount; mi++) {
        tokenIdContracts.push({
          address: miningAgentAddress,
          abi: MiningAgentAbi,
          functionName: "tokenOfOwnerByIndex",
          args: [info.address, BigInt(mi)],
        });
        tokenIdMap.push({ walletIdx: wi });
      }
    }

    const tokenIds: bigint[] = [];
    const validTokenMap: number[] = [];
    if (tokenIdContracts.length > 0) {
      const tokenIdResults = await chunkedMulticall(tokenIdContracts);
      for (let i = 0; i < tokenIdResults.length; i++) {
        const r = tokenIdResults[i];
        if (r.status === "success" && r.result != null) {
          validTokenMap.push(i);
          tokenIds.push(r.result as bigint);
        }
      }
    }

    // No miners — return early
    if (tokenIds.length === 0) {
      const wallets: WalletData[] = walletInfos.map((info) => ({
        address: info.address,
        ethBalance: formatEther(info.ethBalance),
        agentBalance: formatEther(info.agentBalance),
        miners: [],
      }));
      return JSON.stringify(wallets);
    }

    // Phase 3: miner stats (chunked) + art
    const uncachedTokenIds = tokenIds.filter((id) => !artCache.has(id.toString()));

    const FIELDS_PER_TOKEN = 5;
    const detailContracts = tokenIds.flatMap((tokenId) => [
      { address: miningAgentAddress, abi: MiningAgentAbi, functionName: "rarity" as const, args: [tokenId] },
      { address: miningAgentAddress, abi: MiningAgentAbi, functionName: "hashpower" as const, args: [tokenId] },
      { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "tokenMineCount" as const, args: [tokenId] },
      { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "tokenEarnings" as const, args: [tokenId] },
      { address: miningAgentAddress, abi: MiningAgentAbi, functionName: "mintBlock" as const, args: [tokenId] },
    ]);

    const detailResults = await chunkedMulticall(detailContracts);

    // Batch art URI calls for uncached tokens — small chunks (tokenURI returns ~41KB each)
    const ART_CHUNK_SIZE = 2;
    const artResults: { status: string; result?: unknown; error?: unknown }[] = [];
    for (let i = 0; i < uncachedTokenIds.length; i += ART_CHUNK_SIZE) {
      const chunk = uncachedTokenIds.slice(i, i + ART_CHUNK_SIZE);
      const artContracts = chunk.map((tokenId) => ({
        address: miningAgentAddress,
        abi: MiningAgentAbi,
        functionName: "tokenURI" as const,
        args: [tokenId],
      }));
      try {
        const chunkResults = await publicClient.multicall({ contracts: artContracts });
        artResults.push(...chunkResults);
      } catch {
        for (let j = 0; j < chunk.length; j++) {
          artResults.push({ status: "failure" });
        }
      }
    }

    // Populate art cache
    for (let i = 0; i < uncachedTokenIds.length; i++) {
      const r = artResults[i];
      if (r && r.status === "success" && r.result) {
        const imageUri = parseArtFromTokenUri(r.result as string);
        if (imageUri) artCache.set(uncachedTokenIds[i].toString(), imageUri);
      }
    }

    // Build wallet data
    const minersByWallet = new Map<number, MinerData[]>();

    for (let ti = 0; ti < tokenIds.length; ti++) {
      const originalIdx = validTokenMap[ti];
      const { walletIdx } = tokenIdMap[originalIdx];
      const b = ti * FIELDS_PER_TOKEN;

      const rarity = Number((detailResults[b].result as bigint) ?? 0n);
      const hashpower = Number((detailResults[b + 1].result as bigint) ?? 100n);
      const mineCount = (detailResults[b + 2].result as bigint) ?? 0n;
      const earnings = (detailResults[b + 3].result as bigint) ?? 0n;
      const mintBlock = (detailResults[b + 4].result as bigint) ?? 0n;

      const tid = tokenIds[ti].toString();
      const miner: MinerData = {
        tokenId: tid,
        rarity,
        rarityLabel: RARITY_LABELS[rarity] ?? `Tier ${rarity}`,
        hashpower,
        mineCount: mineCount.toString(),
        earnings: formatEther(earnings),
        mintBlock: mintBlock.toString(),
        imageUri: artCache.get(tid),
      };

      if (!minersByWallet.has(walletIdx)) minersByWallet.set(walletIdx, []);
      minersByWallet.get(walletIdx)!.push(miner);
    }

    const wallets: WalletData[] = walletInfos.map((info, i) => ({
      address: info.address,
      ethBalance: formatEther(info.ethBalance),
      agentBalance: formatEther(info.agentBalance),
      miners: minersByWallet.get(i) ?? [],
    }));

    return JSON.stringify(wallets);
  }

  async function handleNetwork(): Promise<string> {
    const results = await publicClient.multicall({
      contracts: [
        { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "totalMines" },
        { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "totalMinted" },
        { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "miningTarget" },
        { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "MINEABLE_SUPPLY" },
        { address: agentCoinAddress, abi: AgentCoinAbi, functionName: "ERA_INTERVAL" },
      ],
    });

    const totalMines = results[0].result as bigint;
    const totalMinted = results[1].result as bigint;
    const miningTarget = results[2].result as bigint;
    const mineableSupply = results[3].result as bigint;
    const eraInterval = results[4].result as bigint;

    const era = totalMines / eraInterval;
    const minesUntilNextEra = eraInterval - (totalMines % eraInterval);
    const supplyPct = Number((totalMinted * 10000n) / mineableSupply) / 100;

    let baseReward = 3;
    for (let i = 0n; i < era; i++) {
      baseReward *= 0.9;
    }
    const nextEraReward = baseReward * 0.9;

    const targetLog = Math.log2(Number(miningTarget));
    const difficulty =
      targetLog > 250 ? "very easy" :
      targetLog > 240 ? "easy" :
      targetLog > 220 ? "moderate" :
      targetLog > 200 ? "hard" : "very hard";

    return JSON.stringify({
      totalMines: totalMines.toString(),
      totalMinted: formatEther(totalMinted),
      mineableSupply: formatEther(mineableSupply),
      era: Number(era),
      minesUntilNextEra: minesUntilNextEra.toString(),
      baseReward,
      nextEraReward,
      difficulty,
      supplyPct,
    });
  }

  function handleConfig(): string {
    const rpcIsDefault = !useX402 && rpcUrl === DEFAULT_RPC;
    const walletCount = getWalletAddresses().length;
    return JSON.stringify({ rpcIsDefault, walletCount });
  }

  function jsonResponse(res: http.ServerResponse, body: string, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(body);
  }

  function errorResponse(res: http.ServerResponse, message: string, status = 500): void {
    jsonResponse(res, JSON.stringify({ error: message }), status);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      if (pathname === "/" || pathname === "") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage);
        return;
      }

      if (pathname === "/api/wallets") {
        const body = await cachedHandler("wallets", () => handleWallets());
        jsonResponse(res, body);
        return;
      }

      if (pathname === "/api/network") {
        const body = await cachedHandler("network", () => handleNetwork());
        jsonResponse(res, body);
        return;
      }

      if (pathname === "/api/config") {
        const body = handleConfig();
        jsonResponse(res, body);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      errorResponse(res, message);
    }
  });

  server.listen(port, "127.0.0.1");
  return server;
}
