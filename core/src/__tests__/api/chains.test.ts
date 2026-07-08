import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createChainHandlers, type ChainHandlerDeps } from '../../api/chains.js';

function makeReply() {
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
  return reply as unknown as FastifyReply & {
    statusCode: number;
    body: unknown;
  };
}

const req = (data: {
  params?: unknown;
  body?: unknown;
  query?: unknown;
}): FastifyRequest =>
  ({ params: data.params, body: data.body, query: data.query }) as never;

const CHAIN = {
  chainId: 1,
  name: 'Ethereum Mainnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: [],
  source: 'chainlist' as const,
};

const ENDPOINT = {
  id: 'e1',
  url: 'https://a.example.com',
  source: 'manual' as const,
  preferred: true,
};

function makeDeps(): ChainHandlerDeps {
  return {
    registry: {
      listChains: vi.fn(async () => ({
        chains: [CHAIN],
        total: 1,
        fetchedAt: null,
      })),
      getChain: vi.fn(async () => CHAIN),
      upsertCustomChain: vi.fn(async () => ({ ...CHAIN, source: 'custom' as const })),
      deleteCustomChain: vi.fn(async () => undefined),
      refreshChainlist: vi.fn(async () => ({
        fetchedAt: new Date(0).toISOString(),
        count: 1,
      })),
    },
    rpcStore: {
      list: vi.fn(async () => [ENDPOINT]),
      add: vi.fn(async () => ENDPOINT),
      remove: vi.fn(async () => undefined),
      setPreferred: vi.fn(async () => [ENDPOINT]),
      updateVerification: vi.fn(async () => undefined),
    },
    providers: {
      getEndpoints: vi.fn(async () => []),
    },
    verify: vi.fn(async () => ({
      ok: true,
      reportedChainId: 1,
      chainIdMatch: true,
      checkedAt: new Date(0).toISOString(),
    })),
  };
}

describe('chain handlers', () => {
  it('listChains forwards q/limit and returns 200', async () => {
    const deps = makeDeps();
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.listChains(
      req({ query: { q: 'eth', limit: 10 } }) as never,
      reply
    );
    expect(deps.registry.listChains).toHaveBeenCalledWith({
      q: 'eth',
      limit: 10,
    });
    expect(reply.statusCode).toBe(200);
    expect((reply.body as { data: { total: number } }).data.total).toBe(1);
  });

  it('getChain 404s on unknown chain with CHAIN_NOT_FOUND', async () => {
    const deps = makeDeps();
    deps.registry.getChain = vi.fn(async () => undefined);
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.getChain(req({ params: { chainId: '424242' } }) as never, reply);
    expect(reply.statusCode).toBe(404);
    expect((reply.body as { code: string }).code).toBe('CHAIN_NOT_FOUND');
  });

  it('deleteChain maps coded CHAIN_NOT_CUSTOM to 400', async () => {
    const deps = makeDeps();
    deps.registry.deleteCustomChain = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'CHAIN_NOT_CUSTOM' });
    });
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.deleteChain(req({ params: { chainId: '1' } }) as never, reply);
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code: string }).code).toBe('CHAIN_NOT_CUSTOM');
  });

  it('deleteChain returns 204 on success', async () => {
    const deps = makeDeps();
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.deleteChain(req({ params: { chainId: '999999' } }) as never, reply);
    expect(deps.registry.deleteCustomChain).toHaveBeenCalledWith(999999);
    expect(reply.statusCode).toBe(204);
  });

  it('addRpc maps coded RPC_ALREADY_EXISTS to 409', async () => {
    const deps = makeDeps();
    deps.rpcStore.add = vi.fn(async () => {
      throw Object.assign(new Error('dup'), { code: 'RPC_ALREADY_EXISTS' });
    });
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.addRpc(
      req({
        params: { chainId: '1' },
        body: { url: 'https://a.example.com' },
      }) as never,
      reply
    );
    expect(reply.statusCode).toBe(409);
    expect((reply.body as { code: string }).code).toBe('RPC_ALREADY_EXISTS');
  });

  it('addRpc maps coded INVALID_RPC_URL to 400', async () => {
    const deps = makeDeps();
    deps.rpcStore.add = vi.fn(async () => {
      throw Object.assign(new Error('bad'), { code: 'INVALID_RPC_URL' });
    });
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.addRpc(
      req({ params: { chainId: '1' }, body: { url: 'ws://x' } }) as never,
      reply
    );
    expect(reply.statusCode).toBe(400);
  });

  it('listRpcs returns stored endpoints plus provider endpoints', async () => {
    const deps = makeDeps();
    const providerEndpoint = {
      id: 'p1',
      url: 'https://provider.example.com',
      source: 'plugin' as const,
      pluginId: 'some-plugin',
    };
    deps.providers.getEndpoints = vi.fn(async () => [providerEndpoint]);
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.listRpcs(
      req({ params: { chainId: '1' }, query: {} }) as never,
      reply
    );
    expect(reply.statusCode).toBe(200);
    const body = reply.body as {
      data: { endpoints: unknown[]; providerEndpoints: unknown[] };
    };
    expect(body.data.endpoints).toEqual([ENDPOINT]);
    expect(body.data.providerEndpoints).toEqual([providerEndpoint]);
  });

  it('listRpcs forwards refresh=true to providers.getEndpoints', async () => {
    const deps = makeDeps();
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.listRpcs(
      req({ params: { chainId: '1' }, query: { refresh: true } }) as never,
      reply
    );
    expect(deps.providers.getEndpoints).toHaveBeenCalledWith(1, true);
    expect(reply.statusCode).toBe(200);
  });

  it('listRpcs degrades to an empty providerEndpoints array when the provider service throws, while stored endpoints are unaffected', async () => {
    const deps = makeDeps();
    deps.providers.getEndpoints = vi.fn(async () => {
      throw new Error('provider fetch failed');
    });
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.listRpcs(
      req({ params: { chainId: '1' }, query: {} }) as never,
      reply
    );
    expect(reply.statusCode).toBe(200);
    const body = reply.body as {
      data: { endpoints: unknown[]; providerEndpoints: unknown[] };
    };
    expect(body.data.endpoints).toEqual([ENDPOINT]);
    expect(body.data.providerEndpoints).toEqual([]);
  });

  it('verifyRpc verifies the stored endpoint and persists the result', async () => {
    const deps = makeDeps();
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.verifyRpc(
      req({ params: { chainId: '1', endpointId: 'e1' } }) as never,
      reply
    );
    expect(deps.verify).toHaveBeenCalledWith('https://a.example.com', 1);
    expect(deps.rpcStore.updateVerification).toHaveBeenCalledWith(
      1,
      'e1',
      expect.objectContaining({ ok: true })
    );
    expect(reply.statusCode).toBe(200);
  });

  it('verifyRpc 404s when the endpoint is unknown', async () => {
    const deps = makeDeps();
    deps.rpcStore.list = vi.fn(async () => []);
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.verifyRpc(
      req({ params: { chainId: '1', endpointId: 'missing' } }) as never,
      reply
    );
    expect(reply.statusCode).toBe(404);
    expect((reply.body as { code: string }).code).toBe('RPC_NOT_FOUND');
  });

  it('checkRpc verifies without persistence', async () => {
    const deps = makeDeps();
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.checkRpc(
      req({
        body: { url: 'https://a.example.com', expectedChainId: 1 },
      }) as never,
      reply
    );
    expect(deps.verify).toHaveBeenCalledWith('https://a.example.com', 1);
    expect(deps.rpcStore.updateVerification).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(200);
  });

  it('refreshChains maps coded CHAINLIST_REFRESH_ERROR to 503', async () => {
    const deps = makeDeps();
    deps.registry.refreshChainlist = vi.fn(async () => {
      throw Object.assign(new Error('offline'), {
        code: 'CHAINLIST_REFRESH_ERROR',
      });
    });
    const h = createChainHandlers(deps);
    const reply = makeReply();
    await h.refreshChains(req({}) as never, reply);
    expect(reply.statusCode).toBe(503);
  });
});
