import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RESULT_BEGIN, RESULT_END } from '@ignite/plugin-types';
import { RpcProviderService } from '../../chains/RpcProviderService.js';
import type { PluginResponse } from '@ignite/plugin-types/types';

const NOW = 1_800_000_000_000;

function makeDeps(overrides?: {
  providers?: { id: string; name: string }[];
  execute?: (
    pluginId: string,
    operation: string,
    options: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ) => Promise<PluginResponse<unknown>>;
  now?: () => number;
  timeoutMs?: number;
}) {
  const providers = overrides?.providers ?? [
    { id: 'acme-rpc', name: 'Acme RPC' },
  ];
  return {
    getProviders: vi.fn(async () => providers),
    execute:
      overrides?.execute ??
      vi.fn(async () => ({
        success: true as const,
        data: { chains: [{ chainId: 1, url: 'https://rpc.acme.example/eth' }] },
      })),
    now: overrides?.now ?? (() => NOW),
    timeoutMs: overrides?.timeoutMs ?? 30_000,
    logger: { warn: vi.fn() },
  };
}

describe('RpcProviderService', () => {
  beforeEach(() => {
    RpcProviderService.resetInstance();
  });

  it('maps provider entries to RpcEndpoint with synthetic ids and label fallback', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: {
        chains: [
          { chainId: 1, url: 'https://rpc.acme.example/a', label: 'Acme A' },
          { chainId: 1, url: 'https://rpc.acme.example/b' },
        ],
      },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toEqual([
      {
        id: 'plugin:acme-rpc:1:0',
        url: 'https://rpc.acme.example/a',
        label: 'Acme A',
        source: 'plugin',
        pluginId: 'acme-rpc',
      },
      {
        id: 'plugin:acme-rpc:1:1',
        url: 'https://rpc.acme.example/b',
        label: 'Acme RPC',
        source: 'plugin',
        pluginId: 'acme-rpc',
      },
    ]);
  });

  it('filters entries by chainId', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: {
        chains: [
          { chainId: 1, url: 'https://rpc.acme.example/eth' },
          { chainId: 10, url: 'https://rpc.acme.example/op' },
        ],
      },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(10);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].url).toBe('https://rpc.acme.example/op');
  });

  it('serves cached entries within the TTL without refetching', async () => {
    const deps = makeDeps();
    const service = new RpcProviderService(deps);
    await service.getEndpoints(1);
    await service.getEndpoints(1);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    let now = NOW;
    const deps = makeDeps({ now: () => now });
    const service = new RpcProviderService(deps);
    await service.getEndpoints(1);
    now += 5 * 60 * 1000 + 1; // just past the 5-minute TTL
    await service.getEndpoints(1);
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when refresh is true', async () => {
    const deps = makeDeps();
    const service = new RpcProviderService(deps);
    await service.getEndpoints(1);
    await service.getEndpoints(1, true);
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('invalidate(pluginId) clears only that plugin, invalidate() clears all', async () => {
    const deps = makeDeps({
      providers: [
        { id: 'acme-rpc', name: 'Acme RPC' },
        { id: 'other-rpc', name: 'Other RPC' },
      ],
    });
    const service = new RpcProviderService(deps);
    await service.getEndpoints(1);
    expect(deps.execute).toHaveBeenCalledTimes(2);

    service.invalidate('acme-rpc');
    await service.getEndpoints(1);
    // acme-rpc refetched, other-rpc still cached
    expect(deps.execute).toHaveBeenCalledTimes(3);

    service.invalidate();
    await service.getEndpoints(1);
    // both refetched now
    expect(deps.execute).toHaveBeenCalledTimes(5);
  });

  it('a failing provider yields no entries without affecting others', async () => {
    const execute = vi.fn(
      async (pluginId: string): Promise<PluginResponse<unknown>> => {
        if (pluginId === 'bad-rpc') {
          return {
            success: false,
            error: { code: 'BOOM', message: 'plugin exploded' },
          };
        }
        return {
          success: true,
          data: {
            chains: [{ chainId: 1, url: 'https://rpc.good.example/eth' }],
          },
        };
      }
    );
    const deps = makeDeps({
      execute,
      providers: [
        { id: 'good-rpc', name: 'Good RPC' },
        { id: 'bad-rpc', name: 'Bad RPC' },
      ],
    });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].pluginId).toBe('good-rpc');
  });

  // parsePluginOutput errors quote the framed result payload, which for
  // granted providers embeds key-bearing URLs — the warn-level provider
  // failure logs must never echo it.
  it('never logs sentinel-framed payload content from provider error messages', async () => {
    const framedPayload = `${RESULT_BEGIN}{"url":"https://rpc.example/v1/SECRETMARKER"}${RESULT_END}`;
    const execute = vi.fn(
      async (pluginId: string): Promise<PluginResponse<unknown>> => {
        if (pluginId === 'error-rpc') {
          return {
            success: false,
            error: {
              code: 'PARSE_ERROR',
              message: `JSON parse error. Framed output: ${framedPayload}`,
            },
          };
        }
        throw new Error(`plugin output unusable: ${framedPayload}`);
      }
    );
    const deps = makeDeps({
      execute,
      providers: [
        { id: 'error-rpc', name: 'Error RPC' }, // response.error warn path
        { id: 'throw-rpc', name: 'Throw RPC' }, // catch-path warn
      ],
    });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toEqual([]);

    const warn = deps.logger.warn as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain('SECRETMARKER');
    // pluginId and the error code survive sanitization for debuggability.
    expect(logged).toContain('error-rpc');
    expect(logged).toContain('PARSE_ERROR');
    expect(logged).toContain('throw-rpc');
  });

  it('truncates oversized provider error messages in logs', async () => {
    const execute = vi.fn(async (): Promise<PluginResponse<unknown>> => {
      return {
        success: false,
        error: { code: 'BOOM', message: 'x'.repeat(5000) },
      };
    });
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    await service.getEndpoints(1);
    const warn = deps.logger.warn as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0]).length).toBeLessThan(300);
  });

  it('drops all entries when the plugin result is not a well-formed chains array', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: { chains: 'not-an-array' },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toEqual([]);
  });

  it('drops all entries when the response exceeds 500 entries', async () => {
    const chains = Array.from({ length: 501 }, (_, i) => ({
      chainId: 1,
      url: `https://rpc.acme.example/${i}`,
    }));
    const execute = vi.fn(async () => ({
      success: true as const,
      data: { chains },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toEqual([]);
  });

  it('drops individual entries with an invalid chainId, url, or oversized/control-char label', async () => {
    const controlCharLabel = ['bad', String.fromCharCode(0), 'label'].join('');
    const execute = vi.fn(async () => ({
      success: true as const,
      data: {
        chains: [
          { chainId: 1, url: 'https://rpc.acme.example/good' },
          { chainId: -1, url: 'https://rpc.acme.example/bad-chain' },
          { chainId: 1, url: 'ws://rpc.acme.example/bad-url' },
          {
            chainId: 1,
            url: 'https://rpc.acme.example/bad-label',
            label: 'x'.repeat(121),
          },
          {
            chainId: 1,
            url: 'https://rpc.acme.example/control-char-label',
            label: controlCharLabel,
          },
        ],
      },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].url).toBe('https://rpc.acme.example/good');
  });

  it('times out a hung provider without hanging, caching an empty result', async () => {
    // Never resolves on its own; only settles when the AbortSignal fires —
    // mirrors the rpcVerify.test.ts abort-aware fake.
    const execute = vi.fn(
      (
        _pluginId: string,
        _op: string,
        _options: unknown,
        opts?: { signal?: AbortSignal }
      ) =>
        new Promise<PluginResponse<unknown>>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(opts.signal?.reason ?? new Error('aborted'))
          );
        })
    );
    const deps = makeDeps({ execute, timeoutMs: 20 });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toEqual([]);
    // Cached (empty) — a second call within TTL must not call execute again.
    await service.getEndpoints(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent getEndpoints calls into one execute per plugin', async () => {
    let resolveFn: ((value: PluginResponse<unknown>) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<PluginResponse<unknown>>((resolve) => {
          resolveFn = resolve;
        })
    );
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const p1 = service.getEndpoints(1);
    const p2 = service.getEndpoints(1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    resolveFn!({
      success: true,
      data: { chains: [{ chainId: 1, url: 'https://rpc.acme.example/eth' }] },
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
  });

  it('reports needs-config when the plugin returns chains: null, with no entries', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: { chains: null },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toEqual([]);
    const statuses = await service.getStatuses();
    expect(statuses).toEqual([{ pluginId: 'acme-rpc', name: 'Acme RPC', state: 'needs-config' }]);
  });

  it('reports ok when the plugin returns an empty array (configured but nothing to report)', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: { chains: [] },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    const statuses = await service.getStatuses();
    expect(statuses).toEqual([{ pluginId: 'acme-rpc', name: 'Acme RPC', state: 'ok' }]);
  });

  it('stays ok (not needs-config) on op failure, timeout, or malformed result', async () => {
    const failing = vi.fn(async () => ({
      success: false as const,
      error: { code: 'BOOM', message: 'plugin exploded' },
    }));
    const deps = makeDeps({ execute: failing });
    const service = new RpcProviderService(deps);
    expect(await service.getStatuses()).toEqual([
      { pluginId: 'acme-rpc', name: 'Acme RPC', state: 'ok' },
    ]);

    RpcProviderService.resetInstance();
    const malformed = vi.fn(async () => ({
      success: true as const,
      data: { chains: 'not-an-array-or-null' },
    }));
    const deps2 = makeDeps({ execute: malformed });
    const service2 = new RpcProviderService(deps2);
    expect(await service2.getStatuses()).toEqual([
      { pluginId: 'acme-rpc', name: 'Acme RPC', state: 'ok' },
    ]);
  });

  it('getStatuses and getEndpoints share a single execute per plugin within the TTL', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      data: { chains: [{ chainId: 1, url: 'https://rpc.acme.example/eth' }] },
    }));
    const deps = makeDeps({ execute });
    const service = new RpcProviderService(deps);
    await service.getEndpoints(1);
    await service.getStatuses();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('getInstance returns a singleton, resetInstance drops it', () => {
    const a = RpcProviderService.getInstance();
    const b = RpcProviderService.getInstance();
    expect(a).toBe(b);
    RpcProviderService.resetInstance();
    const c = RpcProviderService.getInstance();
    expect(c).not.toBe(a);
  });
});
