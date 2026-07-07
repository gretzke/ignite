import { describe, it, expect } from 'vitest';
import { verifyRpcEndpoint, isValidRpcUrl } from '../../chains/rpcVerify.js';

// Minimal fake of global fetch: routes JSON-RPC methods to canned responses.
function fakeRpc(
  responses: Record<string, unknown>,
  opts?: { delayMs?: number }
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const body = JSON.parse(String(init?.body));
    const result = responses[body.method];
    if (result === undefined) {
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'method not found' },
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
    } as Response;
  }) as typeof fetch;
}

const NOW = 1_800_000_000_000; // fixed ms epoch for deterministic block age

describe('isValidRpcUrl', () => {
  it('accepts http(s) URLs and rejects everything else', () => {
    expect(isValidRpcUrl('https://rpc.example.com')).toBe(true);
    expect(isValidRpcUrl('http://127.0.0.1:8545')).toBe(true);
    expect(isValidRpcUrl('ws://rpc.example.com')).toBe(false);
    expect(isValidRpcUrl('file:///etc/passwd')).toBe(false);
    expect(isValidRpcUrl('not a url')).toBe(false);
  });
});

describe('verifyRpcEndpoint', () => {
  it('reports ok with latency, block number and age on a healthy match', async () => {
    const blockTs = Math.floor(NOW / 1000) - 12; // 12s old block
    const result = await verifyRpcEndpoint('https://rpc.example.com', 1, {
      fetchImpl: fakeRpc({
        eth_chainId: '0x1',
        eth_getBlockByNumber: {
          number: '0x112a880',
          timestamp: '0x' + blockTs.toString(16),
        },
      }),
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reportedChainId).toBe(1);
    expect(result.chainIdMatch).toBe(true);
    expect(result.blockNumber).toBe(0x112a880);
    expect(result.blockAgeSeconds).toBe(12);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeTruthy();
  });

  it('hard-fails on chain id mismatch but still reports the seen id', async () => {
    const result = await verifyRpcEndpoint('https://rpc.example.com', 1, {
      fetchImpl: fakeRpc({ eth_chainId: '0xa' }),
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reportedChainId).toBe(10);
    expect(result.chainIdMatch).toBe(false);
    expect(result.error).toMatch(/expected 1.*got 10/i);
  });

  it('fails gracefully when the endpoint returns a JSON-RPC error', async () => {
    const result = await verifyRpcEndpoint('https://rpc.example.com', 1, {
      fetchImpl: fakeRpc({}),
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails gracefully on network errors', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await verifyRpcEndpoint('https://rpc.example.com', 1, {
      fetchImpl: boom,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('times out slow endpoints', async () => {
    const result = await verifyRpcEndpoint('https://rpc.example.com', 1, {
      fetchImpl: fakeRpc({ eth_chainId: '0x1' }, { delayMs: 200 }),
      timeoutMs: 20,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('tolerates a healthy chain id but failing block fetch (degrades, still ok=false with error)', async () => {
    const result = await verifyRpcEndpoint('https://rpc.example.com', 1, {
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === 'eth_chainId') {
          return {
            ok: true,
            json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x1' }),
          } as Response;
        }
        throw new Error('block fetch died');
      }) as typeof fetch,
      now: () => NOW,
    });
    expect(result.reportedChainId).toBe(1);
    expect(result.chainIdMatch).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/block fetch died/);
  });
});
