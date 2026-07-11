import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { ErrorCodes } from '../../types/errors.js';
import { FrontendRuntimeBridge } from '../../plugins/invoke/FrontendRuntimeBridge.js';
import type { WsSocket } from '../../api/ws.js';

// Silence safeSend warning noise when a fake socket throws.
vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeSocket() {
  const socket = {
    send: vi.fn(),
    on: vi.fn(),
  };
  return socket as unknown as WsSocket & { send: ReturnType<typeof vi.fn> };
}

function sentFrames(socket: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return socket.send.mock.calls.map((call) => JSON.parse(call[0] as string));
}

const REQUEST_1 = '00000000-0000-4000-8000-000000000001' as const;
const REQUEST_2 = '00000000-0000-4000-8000-000000000002' as const;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe('FrontendRuntimeBridge', () => {
  beforeEach(() => {
    FrontendRuntimeBridge.resetInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    FrontendRuntimeBridge.resetInstance();
  });

  it('routes requests to the most recently registered host for the plugin', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_1)
      .mockReturnValueOnce(REQUEST_2);
    const bridge = new FrontendRuntimeBridge();
    const first = makeSocket();
    const latest = makeSocket();
    bridge.registerHost(first, ['browser-wallet']);
    bridge.registerHost(latest, ['browser-wallet']);

    const request = bridge.request('browser-wallet', 'getAccounts', {
      scope: 'test',
    });

    expect(first.send).not.toHaveBeenCalled();
    expect(sentFrames(latest)).toEqual([
      {
        type: 'runtime-request',
        requestId: REQUEST_1,
        pluginId: 'browser-wallet',
        operation: 'getAccounts',
        params: { scope: 'test' },
      },
    ]);

    const expected: PluginResponse<unknown> = {
      success: true,
      data: { accounts: [] },
    };
    bridge.handleResponse(latest, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      result: expected,
    });

    await expect(request).resolves.toEqual(expected);
  });

  it('resolves unavailable when no browser host has registered the plugin', async () => {
    const bridge = new FrontendRuntimeBridge();

    await expect(
      bridge.request('browser-wallet', 'getAccounts', {})
    ).resolves.toEqual({
      success: false,
      error: {
        code: ErrorCodes.FRONTEND_RUNTIME_UNAVAILABLE,
        message:
          'No browser session is hosting plugin browser-wallet. Open the Ignite UI in a browser with your wallet available.',
      },
    });
  });

  it('ignores unknown and duplicate responses after a request has resolved', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(REQUEST_1);
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    bridge.registerHost(socket, ['browser-wallet']);

    const request = bridge.request('browser-wallet', 'getAccounts', {});

    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: 'missing-request',
      result: { success: true, data: { accounts: ['stale'] } },
    });
    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      result: { success: true, data: { accounts: ['fresh'] } },
    });
    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      result: { success: true, data: { accounts: ['duplicate'] } },
    });

    await expect(request).resolves.toEqual({
      success: true,
      data: { accounts: ['fresh'] },
    });
  });

  it('maps host transport errors and truncates the host message to 200 chars', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(REQUEST_1);
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    bridge.registerHost(socket, ['browser-wallet']);
    const longError = 'x'.repeat(250);

    const request = bridge.request('browser-wallet', 'getAccounts', {});
    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      error: longError,
    });

    await expect(request).resolves.toEqual({
      success: false,
      error: {
        code: 'FRONTEND_RUNTIME_HOST_ERROR',
        message: 'x'.repeat(200),
      },
    });
  });

  it('rejects malformed host result envelopes without throwing', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(REQUEST_1);
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    bridge.registerHost(socket, ['browser-wallet']);

    const request = bridge.request('browser-wallet', 'getAccounts', {});
    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      result: { data: { accounts: [] } },
    });

    await expect(request).resolves.toEqual({
      success: false,
      error: {
        code: 'FRONTEND_RUNTIME_MALFORMED',
        message: 'Host returned a malformed result',
      },
    });
  });

  it('times out, resolves an envelope, and forgets the request id', async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(REQUEST_1);
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    bridge.registerHost(socket, ['browser-wallet']);

    const request = bridge.request(
      'browser-wallet',
      'getAccounts',
      {},
      {
        timeoutMs: 50,
      }
    );
    await vi.advanceTimersByTimeAsync(50);

    await expect(request).resolves.toEqual({
      success: false,
      error: {
        code: 'FRONTEND_RUNTIME_TIMEOUT',
        message: 'getAccounts timed out after 50ms waiting for the browser',
      },
    });

    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      result: { success: true, data: { accounts: ['late'] } },
    });
    await flushMicrotasks();
  });

  it('aborts, resolves an envelope, and ignores later host responses', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(REQUEST_1);
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    const controller = new AbortController();
    bridge.registerHost(socket, ['browser-wallet']);

    const request = bridge.request(
      'browser-wallet',
      'sendTransaction',
      {},
      {
        signal: controller.signal,
        timeoutMs: 120_000,
      }
    );
    controller.abort();

    await expect(request).resolves.toEqual({
      success: false,
      error: {
        code: 'FRONTEND_RUNTIME_ABORTED',
        message: 'sendTransaction was cancelled before the browser responded',
      },
    });

    bridge.handleResponse(socket, {
      type: 'runtime-response',
      requestId: REQUEST_1,
      result: { success: true, data: { txHash: '0x1234' } },
    });
  });

  it('resolves all pending requests on a socket when that browser tab disconnects', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_1)
      .mockReturnValueOnce(REQUEST_2);
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    bridge.registerHost(socket, ['browser-wallet']);

    const first = bridge.request('browser-wallet', 'getAccounts', {});
    const second = bridge.request('browser-wallet', 'sendTransaction', {});
    bridge.unregisterHost(socket);

    await expect(first).resolves.toEqual({
      success: false,
      error: {
        code: ErrorCodes.FRONTEND_RUNTIME_UNAVAILABLE,
        message: 'browser tab disconnected mid-request',
      },
    });
    await expect(second).resolves.toEqual({
      success: false,
      error: {
        code: ErrorCodes.FRONTEND_RUNTIME_UNAVAILABLE,
        message: 'browser tab disconnected mid-request',
      },
    });
  });

  it('falls back to an older tab for read-only ops when the newest times out', async () => {
    const bridge = new FrontendRuntimeBridge();
    const oldTab = makeSocket();
    const newTab = makeSocket();
    bridge.registerHost(oldTab, ['browser-wallet']);
    bridge.registerHost(newTab, ['browser-wallet']);

    const pending = bridge.request(
      'browser-wallet',
      'getAccounts',
      {},
      { timeoutMs: 25 }
    );
    // The newest registration gets the request first and never answers.
    await flushMicrotasks();
    expect(sentFrames(newTab)).toHaveLength(1);
    expect(sentFrames(oldTab)).toHaveLength(0);

    // After the newest tab's timeout, the older tab is tried — answer it
    // promptly (before ITS timeout) with a success.
    let frame: { requestId: string } | undefined;
    for (let i = 0; i < 100 && !frame; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      frame = sentFrames(oldTab)[0] as { requestId: string } | undefined;
    }
    expect(frame).toBeDefined();
    bridge.handleResponse(oldTab, {
      type: 'runtime-response',
      requestId: frame!.requestId,
      result: { success: true, data: { accounts: [] } },
    });
    const result = (await pending) as PluginResponse<unknown>;
    expect(result.success).toBe(true);
  });

  it('never re-dispatches a mutating operation to another tab', async () => {
    const bridge = new FrontendRuntimeBridge();
    const oldTab = makeSocket();
    const newTab = makeSocket();
    bridge.registerHost(oldTab, ['browser-wallet']);
    bridge.registerHost(newTab, ['browser-wallet']);

    const pending = bridge.request(
      'browser-wallet',
      'sendTransaction',
      {},
      { timeoutMs: 5 }
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = (await pending) as PluginResponse<unknown>;
    // A lost response does not prove the wallet didn't submit: the request
    // must fail on THIS tab rather than double-send through another one.
    expect(result.success).toBe(false);
    expect(sentFrames(newTab)).toHaveLength(1);
    expect(sentFrames(oldTab)).toHaveLength(0);
  });

  it('re-registering a socket replaces the plugin set hosted by that socket', async () => {
    const bridge = new FrontendRuntimeBridge();
    const socket = makeSocket();
    bridge.registerHost(socket, ['browser-wallet']);
    expect(bridge.hasHost('browser-wallet')).toBe(true);

    bridge.registerHost(socket, ['other-plugin']);

    expect(bridge.hasHost('browser-wallet')).toBe(false);
    expect(bridge.hasHost('other-plugin')).toBe(true);
  });
});
