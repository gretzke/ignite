import { concatHex, keccak256, sliceHex } from 'viem';
import { CREATE2_PROXY_ADDRESS, type DeployStrategy, type Hex, type Hex32 } from '@ignite/api';

export function predictCreate2Address(salt: Hex32, initcodeHash: Hex32, proxy: Hex = CREATE2_PROXY_ADDRESS): Hex {
  return `0x${keccak256(concatHex(['0xff', proxy, salt, initcodeHash])).slice(-40)}` as Hex;
}

export function initcodeHashOf(initcode: Hex): Hex32 { return keccak256(initcode) as Hex32; }
export function create2Calldata(salt: Hex32, initcode: Hex): Hex { return concatHex([salt, initcode]); }

export function decomposeCreationCalldata(data: Hex, linkedCreationCode: Hex, strategy: 'create' | 'create2'): { constructorData: Hex } | undefined {
  if (strategy === 'create') {
    if (!data.toLowerCase().startsWith(linkedCreationCode.toLowerCase())) return undefined;
    return { constructorData: `0x${data.slice(linkedCreationCode.length)}` as Hex };
  }
  if (data.length < 66) return undefined;
  const initcode = sliceHex(data, 32);
  if (!initcode.toLowerCase().startsWith(linkedCreationCode.toLowerCase())) return undefined;
  return { constructorData: `0x${initcode.slice(linkedCreationCode.length)}` as Hex };
}

export function effectiveSalt(strategy: DeployStrategy & { kind: 'create2' | 'plugin' }, chainId: number): Hex32 | undefined {
  return strategy.saltPerChain?.[String(chainId)] ?? strategy.salt;
}
