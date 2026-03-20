// Squid Router bridge — deposit address flow (Options B+C).
// SOL → ETH on Base via Chainflip multi-hop (~1-3 minutes).
// Requires SQUID_INTEGRATOR_ID (free, apply at squidrouter.com).

const SQUID_API = "https://v2.api.squidrouter.com/v2";

const SOLANA_CHAIN_ID = "solana";
const BASE_CHAIN_ID = "8453";
const NATIVE_SOL_ADDRESS = "So11111111111111111111111111111111111111112"; // Wrapped SOL mint
const NATIVE_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface DepositInfo {
  depositAddress: string;
  requestId: string;
  expectedReceive: string;
  expiresAt?: string;
}

function getIntegratorId(): string {
  const id = process.env.SQUID_INTEGRATOR_ID;
  if (!id) {
    throw new Error(
      "SQUID_INTEGRATOR_ID is required for the deposit address flow.\n" +
        "Get one free at https://app.squidrouter.com/\n" +
        "Or use direct signing instead: apow fund --solana --key <base58>",
    );
  }
  return id;
}

/**
 * Get a Squid deposit address for SOL → ETH on Base bridging.
 * User sends SOL to this address from any wallet; Squid handles the rest.
 */
export async function getDepositAddress(
  baseAddress: string,
  solAmount: number,
): Promise<DepositInfo> {
  const integratorId = getIntegratorId();
  const lamports = Math.floor(solAmount * 1e9).toString();

  // Step 1: Get route quote
  const routeResponse = await fetch(`${SQUID_API}/route`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integrator-id": integratorId,
    },
    body: JSON.stringify({
      fromChain: SOLANA_CHAIN_ID,
      toChain: BASE_CHAIN_ID,
      fromToken: NATIVE_SOL_ADDRESS,
      toToken: NATIVE_ETH_ADDRESS,
      fromAmount: lamports,
      toAddress: baseAddress,
      quoteOnly: false,
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

  // Step 2: Request deposit address from route
  const depositResponse = await fetch(`${SQUID_API}/deposit-address`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integrator-id": integratorId,
    },
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

  const estimatedReceive = routeData.route?.estimate?.toAmount
    ? (Number(routeData.route.estimate.toAmount) / 1e18).toFixed(6)
    : "unknown";

  return {
    depositAddress: depositData.depositAddress,
    requestId: depositData.requestId || routeData.requestId,
    expectedReceive: estimatedReceive,
    expiresAt: depositData.expiresAt,
  };
}

/**
 * Poll Squid bridge status until complete, failed, or timeout.
 * Default timeout: 10 minutes (Chainflip can be slow).
 */
export async function pollBridgeStatus(
  requestId: string,
  onUpdate?: (status: string) => void,
  timeoutMs = 600_000,
): Promise<{ status: string; ethReceived?: string }> {
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
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const status: string =
          data.squidTransactionStatus || data.status || "unknown";

        if (onUpdate) onUpdate(status);

        if (
          status === "success" ||
          status === "completed" ||
          status === "destination_executed"
        ) {
          return {
            status: "fulfilled",
            ethReceived: data.toChain?.amount
              ? (Number(data.toChain.amount) / 1e18).toFixed(6)
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
