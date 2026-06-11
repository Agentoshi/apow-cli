// AgentCoin freezes all AGENT transfers until the LP pool deploys
// (AgentCoin._update reverts while lpDeployed is false). The gate is sticky
// once unlocked and re-checks at most every interval while locked, so sweeps
// activate on their own when the pool goes live mid-process.
export const LP_RECHECK_INTERVAL_MS = 10 * 60_000;

export function createLpUnlockGate(
  reader: () => Promise<boolean>,
  intervalMs: number = LP_RECHECK_INTERVAL_MS,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let unlocked = false;
  let nextCheckAt = 0;
  return async () => {
    if (unlocked) return true;
    const at = now();
    if (at < nextCheckAt) return false;
    nextCheckAt = at + intervalMs;
    try {
      unlocked = await reader();
    } catch {
      // RPC failure: stay locked; the next interval re-checks.
    }
    return unlocked;
  };
}
