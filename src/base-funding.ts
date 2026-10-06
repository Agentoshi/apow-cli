import { formatEther, parseEther, parseUnits } from "viem";
import { config } from "./config";
import { MIN_ETH, MIN_USDC } from "./bridge/constants";
import { getUsdcBalance, quoteEthForUsdc, quoteEthSwapFees, swapEthToUsdc, type SwapFeeBudget } from "./bridge/uniswap";
import { prepareFunding } from "./funding-plan";
import { account, getFundingClients } from "./wallet";
import { getSignerContext, setSignerContext } from "./policy/context";
import * as ui from "./ui";

export const MINT_GAS_RESERVE_ETH = parseEther(String(MIN_ETH));
const SWAP_GAS_RESERVE_ETH = parseEther("0.00005");

export function requiresUsdc(needsMint = true): boolean {
  return config.useX402 || config.useX402Grind || (needsMint && config.llmProvider === "clawrouter");
}

/** All reads use the funding RPC, so a wallet with only ETH can bootstrap x402. */
export async function prepareBaseFunding(needsMint: boolean, allowSwap: boolean) {
  if (!account) throw new Error("Unlock the configured wallet before funding");
  const fundingAccount = account;
  const { publicClient } = getFundingClients();
  if (await publicClient.getChainId() !== config.chain.id) throw new Error("Funding RPC chain does not match the configured network");
  const mintPrice = needsMint ? await publicClient.readContract({
    address: config.miningAgentAddress,
    abi: [{ name: "getMintPrice", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "getMintPrice",
  }) as bigint : 0n;
  const requirements = {
    ethReserve: mintPrice + MINT_GAS_RESERVE_ETH,
    usdcTarget: requiresUsdc(needsMint) ? parseUnits(String(MIN_USDC), 6) : 0n,
    swapGasReserve: SWAP_GAS_RESERVE_ETH,
  };
  const context = getSignerContext();
  let swapFees: SwapFeeBudget | undefined;
  try {
    setSignerContext("fund");
    const plan = await prepareFunding(requirements, {
      balances: async () => {
        const [eth, usdc] = await Promise.all([
          publicClient.getBalance({ address: fundingAccount.address }),
          requiresUsdc(needsMint) ? getUsdcBalance(fundingAccount.address) : Promise.resolve(0n),
        ]);
        return { eth, usdc };
      },
      quoteEth: quoteEthForUsdc,
      quoteSwapGas: async (eth, usdc) => {
        swapFees = await quoteEthSwapFees(eth, usdc);
        return swapFees.feeReserve;
      },
      swapEth: async (eth, usdc) => {
        ui.info("Funding", `Converting ${formatEther(eth)} ETH to USDC; retaining the mint and gas reserve.`);
        const result = await swapEthToUsdc(eth, usdc, swapFees);
        ui.ok(`Funding swap confirmed: ${result.txHash}`);
      },
    }, allowSwap);
    return { ...plan, mintPrice, requirements };
  } finally {
    setSignerContext(context);
  }
}
