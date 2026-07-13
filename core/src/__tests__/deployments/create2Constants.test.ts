import { describe, expect, it } from 'vitest';
import {
  keccak256,
  recoverTransactionAddress,
  type TransactionSerializedLegacy,
} from 'viem';
import {
  CREATE2_PROXY_ADDRESS,
  CREATE2_PROXY_RUNTIME_CODE,
  CREATE2_PROXY_RUNTIME_HASH,
  CREATE2_PROXY_DEPLOYER_ADDRESS,
  CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX,
} from '@ignite/api';

describe('canonical deterministic deployment proxy constants', () => {
  it('pins the canonical 69-byte runtime and its hash', () => {
    expect((CREATE2_PROXY_RUNTIME_CODE.length - 2) / 2).toBe(69);
    expect(keccak256(CREATE2_PROXY_RUNTIME_CODE)).toBe(CREATE2_PROXY_RUNTIME_HASH);
  });

  it('keeps the presigned proxy deployment material available for setup', () => {
    expect(CREATE2_PROXY_ADDRESS).toBe('0x4e59b44847b379578588920cA78FbF26c0B4956C');
    expect(CREATE2_PROXY_DEPLOYER_ADDRESS).toBe('0x3fab184622dc19b6109349b94811493bf2a45362');
    expect(CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX).toMatch(/^0x(?:[0-9a-f]{2})+$/);
  });

  it('recovers the canonical one-time deployer from the presigned transaction', async () => {
    // A truncated or perturbed constant fails RLP parsing or recovers a
    // different sender — this pins the exact canonical bytes.
    const sender = await recoverTransactionAddress({
      serializedTransaction:
        CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX as TransactionSerializedLegacy,
    });
    expect(sender.toLowerCase()).toBe(CREATE2_PROXY_DEPLOYER_ADDRESS);
  });
});
