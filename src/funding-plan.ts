export interface FundingBalances { eth: bigint; usdc: bigint }
export interface FundingRequirements { ethReserve: bigint; usdcTarget: bigint; swapGasReserve?: bigint }
export interface FundingDependencies {
  balances(): Promise<FundingBalances>;
  quoteEth(usdcOut: bigint): Promise<bigint>;
  quoteSwapGas?(ethIn: bigint, minimumUsdcOut: bigint): Promise<bigint>;
  swapEth(ethIn: bigint, minimumUsdcOut: bigint): Promise<unknown>;
}

/** Quote before spending, preserve the ETH reserve, and verify the landed balance. */
export async function prepareFunding(
  requirements: FundingRequirements,
  deps: FundingDependencies,
  allowSwap: boolean,
): Promise<{ ready: boolean; depositEth: bigint; swapEth: bigint; balances: FundingBalances }> {
  const balances = await deps.balances();
  const missingUsdc = requirements.usdcTarget > balances.usdc ? requirements.usdcTarget - balances.usdc : 0n;
  const swapEth = missingUsdc > 0n ? await deps.quoteEth(missingUsdc) : 0n;
  if (missingUsdc > 0n && swapEth <= 0n) throw new Error("Invalid ETH funding quote");
  const swapGasReserve = missingUsdc > 0n
    ? deps.quoteSwapGas ? await deps.quoteSwapGas(swapEth, missingUsdc) : requirements.swapGasReserve ?? 0n : 0n;
  if (swapGasReserve < 0n) throw new Error("Invalid swap fee quote");
  const requiredEth = requirements.ethReserve + swapEth + swapGasReserve;
  if (balances.eth < requiredEth) {
    return { ready: false, depositEth: requiredEth - balances.eth, swapEth, balances };
  }
  if (missingUsdc === 0n) return { ready: true, depositEth: 0n, swapEth: 0n, balances };
  if (!allowSwap) return { ready: false, depositEth: 0n, swapEth, balances };
  await deps.swapEth(swapEth, missingUsdc);
  const landed = await deps.balances();
  if (landed.eth < requirements.ethReserve || landed.usdc < requirements.usdcTarget) {
    throw new Error("Funding conversion did not meet the ETH reserve and USDC target; stopping before mining");
  }
  return { ready: true, depositEth: 0n, swapEth, balances: landed };
}
