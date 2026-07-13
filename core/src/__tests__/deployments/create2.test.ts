import { describe, expect, it } from 'vitest';
import { getCreate2Address, keccak256 } from 'viem';
import { create2Calldata, decomposeCreationCalldata, initcodeHashOf, predictCreate2Address } from '../../deployments/create2.js';

describe('create2 helpers', () => {
  it('matches viem and round-trips create2 constructor data', () => {
    const salt = `0x${'11'.repeat(32)}` as const;
    const initcode = '0x6000600055deadbeef' as const;
    const hash = initcodeHashOf(initcode);
    expect(predictCreate2Address(salt, hash).toLowerCase()).toBe(getCreate2Address({ from: '0x4e59b44847b379578588920cA78FbF26c0B4956C', salt, bytecodeHash: keccak256(initcode) }).toLowerCase());
    const data = create2Calldata(salt, initcode);
    expect(decomposeCreationCalldata(data, '0x6000600055', 'create2')).toEqual({ constructorData: '0xdeadbeef' });
    expect(decomposeCreationCalldata('0x6000600055', '0x6000600055', 'create')).toEqual({ constructorData: '0x' });
  });
});
