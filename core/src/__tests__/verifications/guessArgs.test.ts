import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, type AbiParameter } from 'viem';
import { guessConstructorArgs } from '../../verifications/guessArgs.js';

const CREATION_CODE = '0x60806040525f80fd';
const INPUTS: AbiParameter[] = [
  { name: 'supply', type: 'uint256' },
  { name: 'owner', type: 'address' },
  { name: '', type: 'bool' },
];
const OWNER = '0x1111111111111111111111111111111111111111';
const TAIL = encodeAbiParameters(INPUTS, [42n, OWNER, true]);

function snapshot(entryId: string, pluginId = 'etherscan') {
  return {
    entryId,
    url: `https://${entryId}.test`,
    verifierPluginId: pluginId,
    label: entryId,
  };
}

function base(overrides: Partial<Parameters<typeof guessConstructorArgs>[0]>) {
  return {
    chainId: 1,
    address: '0x2222222222222222222222222222222222222222',
    creationCode: CREATION_CODE,
    inputs: INPUTS,
    explorers: [snapshot('a')],
    selectedIds: ['a'],
    execute: {
      execute: vi.fn(async () => ({
        success: true,
        data: { txHash: '0xhash' },
      })),
    } as never,
    getTransaction: async () => ({
      to: null,
      input: CREATION_CODE + TAIL.slice(2),
    }),
    ...overrides,
  };
}

describe('guessConstructorArgs', () => {
  it('decodes the tail into JSON-shaped ArgValues (bigint -> string)', async () => {
    const result = await guessConstructorArgs(base({}));
    expect(result.txHash).toBe('0xhash');
    expect(result.encodedTail.toLowerCase()).toBe(TAIL.toLowerCase());
    expect(result.args).toEqual({
      supply: '42', // bigint coerced: JSON.stringify(result) must not throw
      owner: OWNER,
      arg2: true, // unnamed input gets a positional key
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('tries selected explorers first and falls through incapable ones', async () => {
    const calls: string[] = [];
    const execute = {
      execute: vi.fn(async (pluginId: string) => {
        calls.push(pluginId);
        return pluginId === 'blockscout'
          ? { success: true, data: { txHash: '0xhash' } }
          : { success: true, data: null }; // getCreationTx unsupported
      }),
    };
    const result = await guessConstructorArgs(
      base({
        explorers: [snapshot('a', 'sourcify'), snapshot('b', 'blockscout')],
        selectedIds: ['b'],
        execute: execute as never,
      })
    );
    expect(result.txHash).toBe('0xhash');
    expect(calls[0]).toBe('blockscout'); // selected first
  });

  it('fails with CREATION_TX_UNAVAILABLE when no explorer can look up', async () => {
    await expect(
      guessConstructorArgs(
        base({
          execute: {
            execute: vi.fn(async () => ({ success: true, data: null })),
          } as never,
        })
      )
    ).rejects.toMatchObject({ code: 'CREATION_TX_UNAVAILABLE' });
  });

  it('refuses factory creations (tx.to set)', async () => {
    await expect(
      guessConstructorArgs(
        base({
          getTransaction: async () => ({
            to: '0x3333333333333333333333333333333333333333',
            input: '0xdeadbeef',
          }),
        })
      )
    ).rejects.toMatchObject({ code: 'FACTORY_CREATION_UNSUPPORTED' });
  });

  it('fails closed on creation-code prefix mismatch', async () => {
    await expect(
      guessConstructorArgs(
        base({
          getTransaction: async () => ({
            to: null,
            input: '0xffffffff' + TAIL.slice(2),
          }),
        })
      )
    ).rejects.toMatchObject({ code: 'BYTECODE_MISMATCH' });
  });

  it('fails with RPC_TX_UNAVAILABLE when the tx cannot be fetched', async () => {
    await expect(
      guessConstructorArgs(base({ getTransaction: async () => undefined }))
    ).rejects.toMatchObject({ code: 'RPC_TX_UNAVAILABLE' });
  });
});
