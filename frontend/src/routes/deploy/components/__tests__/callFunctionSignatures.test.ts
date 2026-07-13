// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { callFunctionOptions } from '../callFunctionSignatures';

describe('callFunctionOptions', () => {
  it('uses canonical tuple signatures and keeps overloads distinct', () => {
    expect(callFunctionOptions([
      { type: 'function', name: 'configure', stateMutability: 'nonpayable', inputs: [{ name: 'config', type: 'tuple', components: [{ name: 'owner', type: 'address' }, { name: 'limit', type: 'uint256' }] }] },
      { type: 'function', name: 'setValue', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }] },
      { type: 'function', name: 'setValue', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'address' }] },
    ])).toEqual([
      { signature: 'configure((address,uint256))', payable: false },
      { signature: 'setValue(uint256)', payable: false },
      { signature: 'setValue(address)', payable: false },
    ]);
  });
});
