// Transaction plumbing for the signer surface: build (nonce/gas/fees from
// the selected verified RPC), integrity-verify sign-only results, broadcast,
// poll receipts. Core owns all of this for sign-only providers; sign-and-send
// providers only relieve core of signing+submission.
import {
  createPublicClient,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type PublicClient,
} from 'viem';
import type { UnsignedTx, Hex } from '@ignite/plugin-types/types';
import { IgniteError, ErrorCodes } from '../types/errors.js';

export interface TxServiceDeps {
  createClient: (rpcUrl: string) => PublicClient;
}

export interface TxOverrides {
  nonce?: number;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface TxReceiptData {
  status: 'success' | 'reverted';
  blockNumber: number;
  contractAddress: Hex | null;
  gasUsed: string;
  effectiveGasPrice: string;
  nonce?: number;
}

export function toUnsignedTx(args: {
  chainId: number;
  to: Hex | null;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): UnsignedTx {
  return {
    chainId: args.chainId,
    to: args.to,
    data: args.data,
    value: toHex(args.value),
    nonce: args.nonce,
    gas: toHex(args.gas),
    maxFeePerGas: toHex(args.maxFeePerGas),
    maxPriorityFeePerGas: toHex(args.maxPriorityFeePerGas),
  };
}

const RECEIPT_TIMEOUT_MS = 120_000;

export class TxService {
  private deps: TxServiceDeps;
  private accountLocks = new Map<string, Promise<void>>();

  constructor(deps?: Partial<TxServiceDeps>) {
    this.deps = {
      createClient:
        deps?.createClient ??
        ((rpcUrl: string) => createPublicClient({ transport: http(rpcUrl) })),
    };
  }

  async buildTransaction(args: {
    rpcUrl: string;
    chainId: number;
    from: Hex;
    to: Hex | null;
    value: bigint;
    data: Hex;
    overrides?: TxOverrides;
  }): Promise<UnsignedTx> {
    const client = this.deps.createClient(args.rpcUrl);
    const needsFeeEstimate =
      args.overrides?.maxFeePerGas === undefined ||
      args.overrides?.maxPriorityFeePerGas === undefined;
    const [nonce, gas, fees] = await Promise.all([
      args.overrides?.nonce ??
        client.getTransactionCount({ address: args.from, blockTag: 'pending' }),
      args.overrides?.gasLimit ??
        client.estimateGas({
          account: args.from,
          to: args.to ?? undefined,
          value: args.value,
          data: args.data,
        }),
      needsFeeEstimate ? client.estimateFeesPerGas() : undefined,
    ]);

    return toUnsignedTx({
      chainId: args.chainId,
      to: args.to,
      data: args.data,
      value: args.value,
      nonce,
      gas,
      maxFeePerGas: args.overrides?.maxFeePerGas ?? fees!.maxFeePerGas,
      maxPriorityFeePerGas:
        args.overrides?.maxPriorityFeePerGas ?? fees!.maxPriorityFeePerGas,
    });
  }

  computeTxHash(rawTransaction: Hex): Hex {
    return keccak256(rawTransaction);
  }

  async withAccountLock<T>(
    chainId: number,
    address: Hex,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const predecessor = this.accountLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.accountLocks.set(key, current);

    await predecessor;
    try {
      return await fn();
    } finally {
      release();
      if (this.accountLocks.get(key) === current) {
        this.accountLocks.delete(key);
      }
    }
  }

  // Integrity gate for sign-only results: the returned raw tx must be exactly
  // the requested tx, signed by the account the user selected.
  async verifySignedTx(
    rawTransaction: Hex,
    expected: UnsignedTx,
    expectedFrom: Hex
  ): Promise<void> {
    const parsed = parseTransaction(rawTransaction);
    const mismatches: string[] = [];
    const check = (name: string, actual: unknown, want: unknown) => {
      if (actual !== want) mismatches.push(name);
    };

    check('type', parsed.type, 'eip1559');
    check('chainId', parsed.chainId, expected.chainId);
    check(
      'to',
      (parsed.to ?? null)?.toLowerCase() ?? null,
      expected.to?.toLowerCase() ?? null
    );
    check(
      'data',
      (parsed.data ?? '0x').toLowerCase(),
      expected.data.toLowerCase()
    );
    check('value', parsed.value ?? 0n, BigInt(expected.value));
    check('nonce', parsed.nonce, expected.nonce);
    check('gas', parsed.gas, BigInt(expected.gas));
    check('maxFeePerGas', parsed.maxFeePerGas, BigInt(expected.maxFeePerGas));
    check(
      'maxPriorityFeePerGas',
      parsed.maxPriorityFeePerGas,
      BigInt(expected.maxPriorityFeePerGas)
    );

    if (mismatches.length > 0) {
      throw new IgniteError(
        `Signed transaction does not match the requested transaction (mismatched: ${mismatches.join(', ')})`,
        ErrorCodes.SIGNED_TX_MISMATCH
      );
    }

    const from = await recoverTransactionAddress({
      serializedTransaction: rawTransaction as `0x02${string}`,
    });
    if (from.toLowerCase() !== expectedFrom.toLowerCase()) {
      throw new IgniteError(
        'Signed transaction was signed by a different signer than the selected account',
        ErrorCodes.SIGNED_TX_MISMATCH
      );
    }
  }

  async broadcast(rpcUrl: string, rawTransaction: Hex): Promise<Hex> {
    const client = this.deps.createClient(rpcUrl);
    return client.sendRawTransaction({ serializedTransaction: rawTransaction });
  }

  async getBalance(rpcUrl: string, address: Hex): Promise<bigint> {
    return this.deps.createClient(rpcUrl).getBalance({ address });
  }

  async waitForReceipt(
    rpcUrl: string,
    txHash: Hex,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<TxReceiptData> {
    if (opts?.signal?.aborted) {
      throw new IgniteError('Interrupted', ErrorCodes.INTERRUPTED);
    }

    const abortPromise = opts?.signal
      ? new Promise<never>((_, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () =>
              reject(new IgniteError('Interrupted', ErrorCodes.INTERRUPTED)),
            { once: true }
          );
        })
      : undefined;

    const receiptPromise = this.deps
      .createClient(rpcUrl)
      .waitForTransactionReceipt({
        hash: txHash,
        timeout: opts?.timeoutMs ?? RECEIPT_TIMEOUT_MS,
      });
    let receipt: Awaited<typeof receiptPromise>;
    try {
      receipt = await (abortPromise
        ? Promise.race([receiptPromise, abortPromise])
        : receiptPromise);
    } catch (error) {
      if (error instanceof IgniteError) throw error;
      if (/timed?\s*out|timeout/i.test(error instanceof Error ? error.message : String(error))) {
        throw new IgniteError('Transaction receipt timed out', ErrorCodes.RECEIPT_TIMEOUT);
      }
      throw error;
    }

    return {
      status: receipt.status,
      blockNumber: Number(receipt.blockNumber),
      contractAddress: receipt.contractAddress ?? null,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    };
  }
}
