// Pure JSON-RPC health check for an RPC endpoint. No SDK dependency —
// two raw calls: eth_chainId (hard gate) + eth_getBlockByNumber (freshness).
import type { RpcVerificationResult } from '@ignite/api';

export interface RpcVerifyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number; // injectable clock (ms epoch) for deterministic tests
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function isValidRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (payload.error) {
    throw new Error(`RPC error ${payload.error.code}: ${payload.error.message}`);
  }
  return payload.result;
}

function parseHexQuantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Malformed hex quantity: ${String(value)}`);
  }
  return Number.parseInt(value, 16);
}

export async function verifyRpcEndpoint(
  url: string,
  expectedChainId: number,
  opts?: RpcVerifyOptions
): Promise<RpcVerificationResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts?.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();

  if (!isValidRpcUrl(url)) {
    return { ok: false, error: 'Invalid RPC URL (http/https only)', checkedAt };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );

  const result: RpcVerificationResult = { ok: false, checkedAt };
  try {
    const started = performance.now();
    const chainIdHex = await rpcCall(
      url,
      'eth_chainId',
      [],
      fetchImpl,
      controller.signal
    );
    result.latencyMs = Math.round(performance.now() - started);
    result.reportedChainId = parseHexQuantity(chainIdHex);
    result.chainIdMatch = result.reportedChainId === expectedChainId;
    if (!result.chainIdMatch) {
      result.error = `Chain ID mismatch: expected ${expectedChainId}, got ${result.reportedChainId}`;
      return result;
    }

    const block = (await rpcCall(
      url,
      'eth_getBlockByNumber',
      ['latest', false],
      fetchImpl,
      controller.signal
    )) as { number?: unknown; timestamp?: unknown } | null;
    if (!block) {
      result.error = 'Endpoint returned no latest block';
      return result;
    }
    result.blockNumber = parseHexQuantity(block.number);
    const blockTs = parseHexQuantity(block.timestamp);
    result.blockAgeSeconds = Math.max(0, Math.floor(now() / 1000) - blockTs);

    result.ok = true;
    return result;
  } catch (error) {
    // AbortController rejections surface as the abort reason or a DOMException.
    const reason =
      controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : error instanceof Error
          ? error.message
          : String(error);
    result.error = reason;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
