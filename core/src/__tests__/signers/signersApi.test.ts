import { describe, expect, it, vi } from 'vitest';
import { createSignerHandlers } from '../../api/signers.js';
import type { JobRunner } from '../../jobs/JobManager.js';

function fakeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

const CHAIN = {
  chainId: 11155111,
  name: 'Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: [],
  source: 'chainlist' as const,
};

describe('signer handlers', () => {
  it('lists signer accounts', async () => {
    const handlers = createSignerHandlers({
      signers: {
        listAccounts: vi.fn(async () => ({ providers: [] })),
        send: vi.fn(),
      } as never,
    });
    const reply = fakeReply();
    await handlers.listSignerAccounts({ query: {} } as never, reply as never);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ data: { providers: [] } });
  });

  it('resolves the rpc endpoint and starts a signer.send job', async () => {
    const start = vi.fn(
      (_type: string, _params: Record<string, unknown>, _runner: JobRunner) => ({
        id: 'job-1',
        type: 'signer.send',
        params: {},
        state: 'queued' as const,
        createdAt: new Date(0).toISOString(),
        events: [],
      })
    );
    const handlers = createSignerHandlers({
      signers: {
        listAccounts: vi.fn(),
        send: vi.fn(async () => ({
          txHash: '0x1',
          status: 'success',
          blockNumber: 1,
        })),
      } as never,
      jobs: { start } as never,
      registry: { getChain: vi.fn(async () => CHAIN) } as never,
      resolveRpcUrl: vi.fn(async () => 'https://rpc.example'),
    });
    const reply = fakeReply();
    await handlers.sendSignerTx(
      {
        body: {
          pluginId: 'private-key',
          accountId: 'k1',
          chainId: 11155111,
          rpcEndpointId: 'manual:0',
          to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          value: '0',
          data: '0x',
        },
      } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith(
      'signer.send',
      expect.objectContaining({
        pluginId: 'private-key',
        chainId: 11155111,
      }),
      expect.any(Function)
    );
    const params = start.mock.calls[0]![1];
    expect(params).not.toHaveProperty('rpcUrl');
  });

  it('404s an unknown rpc endpoint id', async () => {
    const handlers = createSignerHandlers({
      signers: {} as never,
      jobs: { start: vi.fn() } as never,
      registry: { getChain: vi.fn(async () => CHAIN) } as never,
      resolveRpcUrl: vi.fn(async () => undefined),
    });
    const reply = fakeReply();
    await handlers.sendSignerTx(
      {
        body: {
          pluginId: 'p',
          accountId: 'a',
          chainId: 11155111,
          rpcEndpointId: 'nope',
          to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          value: '0',
        },
      } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(404);
  });
});
