// Squid Router bridge — deposit address flow.
// Supports SOL→Base and ETH→Base via Chainflip multi-hop (~1-3 minutes).
// Requires SQUID_INTEGRATOR_ID (free, apply at squidrouter.com).

import { CHAIN_IDS, TOKENS } from "./constants";
import { formatEther, parseUnits } from "viem";

const SQUID_API = "https://v2.api.squidrouter.com/v2";

export interface SquidRoute {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  srcDecimals: number;
  dstDecimals: number;
}

export const SQUID_ROUTES = {
  sol_to_eth: {
    fromChain: CHAIN_IDS.solana,
    fromToken: TOKENS.solana.nativeWrapped,
    toChain: CHAIN_IDS.base,
    toToken: TOKENS.base.nativeSquid,
    srcDecimals: 9,
    dstDecimals: 18,
  },
  sol_usdc_to_base_eth: {
    fromChain: CHAIN_IDS.solana,
    fromToken: TOKENS.solana.usdc,
    toChain: CHAIN_IDS.base,
    toToken: TOKENS.base.nativeSquid,
    srcDecimals: 6,
    dstDecimals: 18,
  },
  eth_to_base_eth: {
    fromChain: CHAIN_IDS.ethereum,
    fromToken: TOKENS.ethereum.nativeWrapped,
    toChain: CHAIN_IDS.base,
    toToken: TOKENS.base.nativeSquid,
    srcDecimals: 18,
    dstDecimals: 18,
  },
} as const;

export interface DepositInfo {
  depositAddress: string;
  requestId: string;
  expectedReceive: string;
  minimumReceive: string;
  expiresAt?: string;
}

function getIntegratorId(): string {
  const id = process.env.SQUID_INTEGRATOR_ID;
  if (!id) {
    throw new Error(
      "SQUID_INTEGRATOR_ID is required for bridging.\n" +
        "Get one free at https://app.squidrouter.com/",
    );
  }
  return id;
}

/**
 * Get a Squid deposit address for bridging to Base.
 * User sends tokens to this address from any wallet; Squid handles the rest.
 */
export async function getDepositAddress(
  baseAddress: string,
  amount: number,
  route: SquidRoute = SQUID_ROUTES.sol_to_eth,
  minimumEth = 0n,
): Promise<DepositInfo> {
  const integratorId = getIntegratorId();
  if (!/^0x[0-9a-fA-F]{40}$/.test(baseAddress) || !Number.isFinite(amount) || amount <= 0) throw new Error("Invalid bridge recipient or amount");
  const rawAmount = parseUnits(amount.toFixed(route.srcDecimals), route.srcDecimals).toString();

  // Step 1: Get route quote
  const routeResponse = await fetch(`${SQUID_API}/route`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integrator-id": integratorId,
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      fromChain: route.fromChain,
      toChain: route.toChain,
      fromToken: route.fromToken,
      toToken: route.toToken,
      fromAmount: rawAmount,
      toAddress: baseAddress,
      quoteOnly: false,
      slippage: 2,
      enableBoost: true,
      prefer: ["CHAINFLIP_DEPOSIT_ADDRESS"],
    }),
  });

  if (!routeResponse.ok) {
    const body = await routeResponse.text();
    throw new Error(`Squid route API error (${routeResponse.status}): ${body}`);
  }

  const routeData = (await routeResponse.json()) as any;
  if (routeData.error) {
    throw new Error(
      `Squid route error: ${routeData.error.message || JSON.stringify(routeData.error)}`,
    );
  }

  // Guard: if the route returned a transactionRequest instead of supporting
  // deposit-address flow, the source chain likely requires a contract call
  // (e.g., EVM chains without Chainflip deposit address support).
  const tx = routeData.route?.transactionRequest;
  if (tx && !routeData.route?.params?.prefer?.includes("CHAINFLIP_DEPOSIT_ADDRESS")) {
    throw new Error(
      "DEPOSIT_ADDRESS_UNAVAILABLE: Squid returned a contract-call route instead of a deposit address for this chain.\n" +
        "This means the bridge requires an on-chain transaction from the source chain.\n" +
        "Send ETH on Base directly instead. No deposit address was issued.",
    );
  }

  const minReceive = routeData.route?.estimate?.toAmountMin;
  if (typeof minReceive !== "string" || !/^\d+$/.test(minReceive) || BigInt(minReceive) < minimumEth) {
    throw new Error("The bridge quote does not guarantee enough Base ETH after fees and slippage. Increase the ETH target with --amount; no deposit address was issued.");
  }
  // Step 2: Request deposit address from a validated route
  const depositResponse = await fetch(`${SQUID_API}/deposit-address`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integrator-id": integratorId,
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      routeData: routeData.route,
    }),
  });

  if (!depositResponse.ok) {
    const body = await depositResponse.text();
    throw new Error(
      `Squid deposit-address API error (${depositResponse.status}): ${body}`,
    );
  }

  const depositData = (await depositResponse.json()) as any;
  const validAddress = typeof depositData.depositAddress === "string" && (route.fromChain === "solana"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(depositData.depositAddress)
    : /^0x[0-9a-fA-F]{40}$/.test(depositData.depositAddress));
  if (!validAddress
    || !(depositData.requestId || routeData.requestId)) throw new Error("Bridge returned an invalid deposit address or request ID");
  if (depositData.expiresAt && (!Number.isFinite(Date.parse(depositData.expiresAt)) || Date.parse(depositData.expiresAt) <= Date.now())) {
    throw new Error("Bridge returned an expired or invalid deposit-address expiry");
  }

  const toAmount = routeData.route?.estimate?.toAmount;
  const estimatedReceive = toAmount
    ? (Number(toAmount) / 10 ** route.dstDecimals).toFixed(route.dstDecimals === 6 ? 2 : 6)
    : "unknown";

  return {
    depositAddress: depositData.depositAddress,
    requestId: depositData.requestId || routeData.requestId,
    expectedReceive: estimatedReceive,
    minimumReceive: formatEther(BigInt(minReceive)),
    expiresAt: depositData.expiresAt,
  };
}

/**
 * Poll Squid bridge status until complete, failed, or timeout.
 * Default timeout: 10 minutes (Chainflip can be slow).
 */
export async function pollBridgeStatus(
  requestId: string,
  dstDecimals = 18,
  onUpdate?: (status: string) => void,
  timeoutMs = 600_000,
): Promise<{ status: string; received?: string }> {
  const integratorId = getIntegratorId();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const params = new URLSearchParams({
        requestId,
        bridgeType: "chainflipmultihop",
      });

      const response = await fetch(`${SQUID_API}/status?${params}`, {
        headers: { "x-integrator-id": integratorId },
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const status = String(data.squidTransactionStatus || data.status || "unknown").toLowerCase();

        if (onUpdate) onUpdate(status);

        if (
          status === "success" ||
          status === "completed" ||
          status === "destination_executed"
        ) {
          return {
            status: "fulfilled",
            received: data.toChain?.amount
              ? (Number(data.toChain.amount) / 10 ** dstDecimals).toFixed(
                  dstDecimals === 6 ? 2 : 6,
                )
              : undefined,
          };
        }

        if (status === "failed" || status === "refunded") {
          throw new Error(`Bridge failed with status: ${status}`);
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("failed") || err.message.includes("refunded"))
      ) {
        throw err;
      }
      // Transient fetch error — keep polling
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(
    "Bridge timed out after 10 minutes. Check Squid explorer: https://axelarscan.io/",
  );
}
