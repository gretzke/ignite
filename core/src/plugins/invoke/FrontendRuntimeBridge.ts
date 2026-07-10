import type { PluginResponse } from '@ignite/plugin-types/types';
import type { WsSocket } from '../../api/ws.js';
import { ErrorCodes } from '../../types/errors.js';
import { getLogger } from '../../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const HOST_ERROR_MAX_CHARS = 200;

export interface RuntimeResponseFrame {
  type: 'runtime-response';
  requestId: string;
  result?: unknown;
  error?: string;
}

interface RuntimeRequestFrame {
  type: 'runtime-request';
  requestId: string;
  pluginId: string;
  operation: string;
  params: unknown;
}

interface PendingRequest {
  resolve: (response: PluginResponse<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
  socket: WsSocket;
  operation: string;
  abortListener?: () => void;
  signal?: AbortSignal;
}

export class FrontendRuntimeBridge {
  private static instance: FrontendRuntimeBridge;
  private socketPlugins = new Map<WsSocket, Set<string>>();
  private pluginHosts = new Map<string, WsSocket[]>();
  private pending = new Map<string, PendingRequest>();

  static getInstance(): FrontendRuntimeBridge {
    if (!FrontendRuntimeBridge.instance) {
      FrontendRuntimeBridge.instance = new FrontendRuntimeBridge();
    }
    return FrontendRuntimeBridge.instance;
  }

  static resetInstance(): void {
    FrontendRuntimeBridge.instance =
      undefined as unknown as FrontendRuntimeBridge;
  }

  registerHost(socket: WsSocket, pluginIds: string[]): void {
    this.removeSocketFromHostMaps(socket);
    this.socketPlugins.set(socket, new Set(pluginIds));
    for (const pluginId of pluginIds) {
      const hosts = this.pluginHosts.get(pluginId) ?? [];
      hosts.push(socket);
      this.pluginHosts.set(pluginId, hosts);
    }
  }

  unregisterHost(socket: WsSocket): void {
    this.removeSocketFromHostMaps(socket);
    for (const [requestId, pending] of [...this.pending.entries()]) {
      if (pending.socket !== socket) continue;
      this.settle(
        requestId,
        unavailable('browser tab disconnected mid-request')
      );
    }
  }

  handleResponse(socket: WsSocket, frame: RuntimeResponseFrame): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.socket !== socket) return;

    if (frame.error !== undefined) {
      this.settle(frame.requestId, {
        success: false,
        error: {
          code: 'FRONTEND_RUNTIME_HOST_ERROR',
          message: frame.error.slice(0, HOST_ERROR_MAX_CHARS),
        },
      });
      return;
    }

    if (!isPluginResponse(frame.result)) {
      this.settle(frame.requestId, {
        success: false,
        error: {
          code: 'FRONTEND_RUNTIME_MALFORMED',
          message: 'Host returned a malformed result',
        },
      });
      return;
    }

    this.settle(frame.requestId, frame.result);
  }

  hasHost(pluginId: string): boolean {
    return this.getLatestHost(pluginId) !== undefined;
  }

  request(
    pluginId: string,
    operation: string,
    params: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<PluginResponse<unknown>> {
    // Newest registration first; a half-dead tab (backgrounded with a
    // silently dropped WS) can be the latest host and eat requests, so
    // read-only operations fall back to older registered tabs on timeout or
    // disconnect. Mutating operations NEVER retry on another host: a lost
    // response does not prove the wallet didn't submit, and a re-dispatch
    // could double-send a transaction.
    const hosts = [...(this.pluginHosts.get(pluginId) ?? [])].reverse();
    if (hosts.length === 0) {
      return Promise.resolve(noHost(pluginId));
    }
    if (!READ_ONLY_FALLBACK_OPS.has(operation) || hosts.length === 1) {
      return this.requestFromSocket(
        hosts[0],
        pluginId,
        operation,
        params,
        opts
      );
    }
    return (async () => {
      let last: PluginResponse<unknown> = noHost(pluginId);
      for (const socket of hosts) {
        last = await this.requestFromSocket(
          socket,
          pluginId,
          operation,
          params,
          opts
        );
        if (last.success || !isDeadHostFailure(last)) return last;
      }
      return last;
    })();
  }

  private requestFromSocket(
    socket: WsSocket,
    pluginId: string,
    operation: string,
    params: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<PluginResponse<unknown>> {
    if (opts?.signal?.aborted) {
      return Promise.resolve(aborted(operation));
    }

    const requestId = crypto.randomUUID();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const frame: RuntimeRequestFrame = {
      type: 'runtime-request',
      requestId,
      pluginId,
      operation,
      params,
    };

    return new Promise<PluginResponse<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(requestId, {
          success: false,
          error: {
            code: 'FRONTEND_RUNTIME_TIMEOUT',
            message: `${operation} timed out after ${timeoutMs}ms waiting for the browser`,
          },
        });
      }, timeoutMs);

      const pending: PendingRequest = {
        resolve,
        timer,
        socket,
        operation,
        signal: opts?.signal,
      };
      if (opts?.signal) {
        const abortListener = () => {
          this.settle(requestId, aborted(operation));
        };
        pending.abortListener = abortListener;
        opts.signal.addEventListener('abort', abortListener, { once: true });
      }

      this.pending.set(requestId, pending);
      safeSend(socket, frame);
    });
  }

  private getLatestHost(pluginId: string): WsSocket | undefined {
    const hosts = this.pluginHosts.get(pluginId);
    if (!hosts || hosts.length === 0) return undefined;
    return hosts[hosts.length - 1];
  }

  private removeSocketFromHostMaps(socket: WsSocket): void {
    const pluginIds = this.socketPlugins.get(socket);
    if (!pluginIds) return;
    for (const pluginId of pluginIds) {
      const hosts = this.pluginHosts
        .get(pluginId)
        ?.filter((host) => host !== socket);
      if (!hosts || hosts.length === 0) {
        this.pluginHosts.delete(pluginId);
      } else {
        this.pluginHosts.set(pluginId, hosts);
      }
    }
    this.socketPlugins.delete(socket);
  }

  private settle(requestId: string, response: PluginResponse<unknown>): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    pending.resolve(response);
  }
}

function isPluginResponse(value: unknown): value is PluginResponse<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { success?: unknown }).success === 'boolean'
  );
}

// Operations safe to re-dispatch to another browser tab: they read wallet
// state and cause no prompts or transactions.
const READ_ONLY_FALLBACK_OPS = new Set(['getAccounts', 'listWallets']);

function isDeadHostFailure(response: PluginResponse<unknown>): boolean {
  if (response.success) return false;
  return (
    response.error.code === 'FRONTEND_RUNTIME_TIMEOUT' ||
    response.error.code === ErrorCodes.FRONTEND_RUNTIME_UNAVAILABLE
  );
}

function noHost(pluginId: string): PluginResponse<unknown> {
  return unavailable(
    `No browser session is hosting plugin ${pluginId}. Open the Ignite UI in a browser with your wallet available.`
  );
}

function unavailable(message: string): PluginResponse<unknown> {
  return {
    success: false,
    error: {
      code: ErrorCodes.FRONTEND_RUNTIME_UNAVAILABLE,
      message,
    },
  };
}

function aborted(operation: string): PluginResponse<unknown> {
  return {
    success: false,
    error: {
      code: 'FRONTEND_RUNTIME_ABORTED',
      message: `${operation} was cancelled before the browser responded`,
    },
  };
}

function safeSend(socket: WsSocket, payload: unknown): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch (err) {
    getLogger().warn(`ws send failed: ${String(err)}`);
  }
}
