export type SignerContext = "default" | "mine" | "mint" | "fund" | "sweep" | "wallet-fund" | "dashboard" | "policy";

let currentContext: SignerContext = "default";

export function setSignerContext(context: SignerContext): void {
  currentContext = context;
}

export function getSignerContext(): SignerContext {
  return currentContext;
}

