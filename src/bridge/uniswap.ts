// Uniswap V3 SwapRouter02 on Base — ETH↔USDC swaps.
// No new npm deps — uses viem's built-in ABI encoding.

import type { Address, Hex } from "viem";
import { encodeFunctionData, formatEther, formatUnits } from "viem";

import { TOKENS, SLIPPAGE_BPS } from "./constants";
import { publicClient, requireWallet } from "../wallet";

const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const WETH = TOKENS.base.weth;
const USDC = TOKENS.base.usdc;
const FEE_TIER = 500; // 0.05% pool (highest TVL)

const erc20Abi = [
  {
    type: "function" as const,
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
  {
    type: "function" as const,
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
  {
    type: "function" as const,
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

const swapRouterAbi = [
  {
    name: "exactInputSingle",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multicall",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    name: "unwrapWETH9",
    type: "function" as const,
    stateMutability: "payable" as const,
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
] as const;

/** Get USDC balance for an address on Base. */
export async function getUsdcBalance(address: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

/**
 * Swap ETH → USDC via Uniswap V3 on Base.
 * Sends ETH as msg.value; router auto-wraps to WETH.
 */
export async function swapEthToUsdc(
  ethAmount: bigint,
  minUsdcOut: bigint,
): Promise<{ txHash: Hex; usdcReceived: string }> {
  const { account, walletClient } = requireWallet();

  const txHash = await walletClient.writeContract({
    address: SWAP_ROUTER,
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: FEE_TIER,
        recipient: account.address,
        amountIn: ethAmount,
        amountOutMinimum: minUsdcOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
    value: ethAmount,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error("ETH→USDC swap reverted");
  }

  // Read USDC balance after swap to report actual amount
  const usdcBal = await getUsdcBalance(account.address);
  return { txHash, usdcReceived: formatUnits(usdcBal, 6) };
}

/**
 * Swap USDC → ETH via Uniswap V3 on Base.
 * Approves USDC (if needed), then multicalls [exactInputSingle, unwrapWETH9].
 */
export async function swapUsdcToEth(
  usdcAmount: bigint,
  minEthOut: bigint,
): Promise<{ txHash: Hex; ethReceived: string }> {
  const { account, walletClient } = requireWallet();

  // Check and set USDC allowance
  const allowance = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, SWAP_ROUTER],
  })) as bigint;

  if (allowance < usdcAmount) {
    const approveTx = await walletClient.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER, usdcAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // Encode exactInputSingle: USDC → WETH, recipient = SWAP_ROUTER (so it holds WETH)
  const swapData = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC,
        tokenOut: WETH,
        fee: FEE_TIER,
        recipient: SWAP_ROUTER, // Router holds WETH temporarily
        amountIn: usdcAmount,
        amountOutMinimum: minEthOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  // Encode unwrapWETH9: router converts WETH → ETH and sends to user
  const unwrapData = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "unwrapWETH9",
    args: [minEthOut, account.address],
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min

  const txHash = await walletClient.writeContract({
    address: SWAP_ROUTER,
    abi: swapRouterAbi,
    functionName: "multicall",
    args: [deadline, [swapData, unwrapData]],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error("USDC→ETH swap reverted");
  }

  const ethBal = await publicClient.getBalance({ address: account.address });
  return { txHash, ethReceived: formatEther(ethBal) };
}
