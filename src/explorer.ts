import { config } from "./config";

function baseUrl(): string {
  return config.chainName === "baseSepolia"
    ? "https://sepolia.basescan.org"
    : "https://basescan.org";
}

export function txUrl(hash: string): string {
  return `${baseUrl()}/tx/${hash}`;
}

export function addressUrl(addr: string): string {
  return `${baseUrl()}/address/${addr}`;
}

export function tokenUrl(contract: string, tokenId: bigint | string): string {
  return `${baseUrl()}/nft/${contract}/${tokenId.toString()}`;
}
