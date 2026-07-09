// Transaction plumbing for the signer surface: build (nonce/gas/fees from
// the selected verified RPC), integrity-verify sign-only results, broadcast,
// poll receipts. Core owns all of this for sign-only providers; sign-and-send
// providers only relieve core of signing+submission.
import {
  createPublicClient,
  http,
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
  }): Promise<UnsignedTx> {
    const client = this.deps.createClient(args.rpcUrl);
    const [nonce, gas, fees] = await Promise.all([
      client.getTransactionCount({ address: args.from, blockTag: 'pending' }),
      client.estimateGas({
        account: args.from,
        to: args.to ?? undefined,
        value: args.value,
        data: args.data,
      }),
      client.estimateFeesPerGas(),
    ]);

    return toUnsignedTx({
      chainId: args.chainId,
      to: args.to,
      data: args.data,
      value: args.value,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
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

  async waitForReceipt(
    rpcUrl: string,
    txHash: Hex,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: number }> {
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
    const receipt = await (abortPromise
      ? Promise.race([receiptPromise, abortPromise])
      : receiptPromise);

    return {
      status: receipt.status,
      blockNumber: Number(receipt.blockNumber),
    };
  }
}
