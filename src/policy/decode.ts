import type { Address, Hex } from "viem";
import { getAddress, hexToBigInt, keccak256, padHex, sliceHex, stringToHex } from "viem";

import { TOKENS } from "../bridge/constants";

export const USDC_ADDRESS = TOKENS.base.usdc;
export const SWAP_ROUTER02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;

export const SELECTORS = {
  mine: selector("mine(uint256,string,uint256)"),
  getChallenge: selector("getChallenge(address)"),
  mint: selector("mint(string)"),
  transfer: selector("transfer(address,uint256)"),
  approve: selector("approve(address,uint256)"),
  exactInputSingle: selector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"),
  multicall: selector("multicall(uint256,bytes[])"),
};

export function selector(signature: string): Hex {
  return sliceHex(keccak256(stringToHex(signature)), 0, 4);
}

export function calldataSelector(data?: Hex): Hex {
  return data && data.length >= 10 ? sliceHex(data, 0, 4) : "0x";
}

function word(data: Hex, index: number): Hex {
  const start = 4 + index * 32;
  return sliceHex(data, start, start + 32);
}

export function readAddressArg(data: Hex, index: number): Address {
  return getAddress(`0x${word(data, index).slice(-40)}`) as Address;
}

export function readUintArg(data: Hex, index: number): bigint {
  return hexToBigInt(word(data, index));
}

export function parseErc20Transfer(data: Hex): { recipient: Address; amount: bigint } | null {
  if (calldataSelector(data) !== SELECTORS.transfer) return null;
  return { recipient: readAddressArg(data, 0), amount: readUintArg(data, 1) };
}

export function parseErc20Approve(data: Hex): { spender: Address; amount: bigint } | null {
  if (calldataSelector(data) !== SELECTORS.approve) return null;
  return { spender: readAddressArg(data, 0), amount: readUintArg(data, 1) };
}

export interface Eip3009Payment {
  payee: Address;
  usdc: number;
  validBefore?: bigint;
}

function getTypedMessage(parameters: unknown): Record<string, unknown> {
  const obj = parameters as { message?: unknown };
  return obj.message && typeof obj.message === "object" ? obj.message as Record<string, unknown> : {};
}

function addressFromUnknown(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return getAddress(value) as Address;
}

export function parseEip3009(parameters: unknown): Eip3009Payment | null {
  const typed = parameters as {
    domain?: { verifyingContract?: unknown };
    primaryType?: unknown;
  };
  const verifying = addressFromUnknown(typed.domain?.verifyingContract);
  if (!verifying || verifying.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    return null;
  }
  if (typed.primaryType !== "TransferWithAuthorization" && typed.primaryType !== "ReceiveWithAuthorization") {
    return null;
  }
  const message = getTypedMessage(parameters);
  const payee = addressFromUnknown(message.to);
  const rawValue = typeof message.value === "bigint" ? message.value : BigInt(String(message.value ?? "0"));
  if (!payee) return null;
  const validBefore = message.validBefore !== undefined ? BigInt(String(message.validBefore)) : undefined;
  return { payee, usdc: Number(rawValue) / 1_000_000, validBefore };
}

export function isPermitTypedData(parameters: unknown): boolean {
  const primaryType = (parameters as { primaryType?: unknown }).primaryType;
  return typeof primaryType === "string" && /permit/i.test(primaryType);
}

export function padAddress(address: Address): Hex {
  return padHex(address, { size: 32 });
}

