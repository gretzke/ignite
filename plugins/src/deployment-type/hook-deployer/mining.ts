import { keccak256 } from 'viem';

export type Hex = `0x${string}`;
const MASK = 0x3fff;
const MAX_MS = 30_000;

const hex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const bytes = (value: Hex): Uint8Array => {
  const output = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return output;
};
const saltFor = (counter: number): Uint8Array => {
  const salt = new Uint8Array(32); let value = BigInt(counter);
  for (let index = 31; index >= 0; index--) { salt[index] = Number(value & 0xffn); value >>= 8n; }
  return salt;
};
export function create2Address(initcodeHash: Uint8Array, proxy: Uint8Array, salt: Uint8Array): Hex {
  const payload = new Uint8Array(1 + proxy.length + salt.length + initcodeHash.length);
  payload[0] = 0xff; payload.set(proxy, 1); payload.set(salt, 1 + proxy.length); payload.set(initcodeHash, 1 + proxy.length + salt.length);
  return `0x${keccak256(hex(payload)).slice(-40)}` as Hex;
}
export function mine(initcodeHash: Uint8Array, proxy: Uint8Array, flags: number, cap = Number(process.env.HOOK_MINER_CAP ?? 300_000)): { salt: Hex; predictedAddress: Hex } | null {
  const started = Date.now();
  for (let counter = 0; counter < cap; counter++) {
    if (Date.now() - started > MAX_MS) return null;
    const salt = saltFor(counter); const predictedAddress = create2Address(initcodeHash, proxy, salt);
    if ((BigInt(predictedAddress) & BigInt(MASK)) === BigInt(flags)) return { salt: hex(salt), predictedAddress };
  }
  return null;
}
export const toBytes = bytes;
