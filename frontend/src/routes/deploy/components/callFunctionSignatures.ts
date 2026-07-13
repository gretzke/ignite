import { toFunctionSignature, type AbiFunction } from 'viem';
import type { AbiInput } from './AbiArgField';

export interface CallFunctionOption {
  signature: string;
  payable: boolean;
}

type AbiFunctionLike = {
  type?: string;
  name?: string;
  inputs?: AbiInput[];
  stateMutability?: string;
};

/** Build selectors from the ABI rather than reconstructing them from the
 * shallow `type` field. viem expands tuple components into the canonical ABI
 * signature, which keeps overloaded functions distinguishable. */
export function callFunctionOptions(
  abi: AbiFunctionLike[] | undefined
): CallFunctionOption[] {
  return (abi ?? [])
    .filter(
      (item) => item.type === 'function' && item.stateMutability !== 'pure'
    )
    .map((item) => ({
      signature: toFunctionSignature(item as unknown as AbiFunction),
      payable: item.stateMutability === 'payable',
    }));
}
