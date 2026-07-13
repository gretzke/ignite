// D5 fixture/proxy proof.  The larger engine scenarios share this canonical
// setup: each fresh anvil gets the EIP-2470 proxy before a CREATE2 plan runs.
import { afterAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CREATE2_PROXY_ADDRESS,
  CREATE2_PROXY_DEPLOYER_ADDRESS,
  CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX,
  CREATE2_PROXY_RUNTIME_HASH,
} from '@ignite/api';

// Resolved locally with `docker image inspect` on 2026-07-13. Keeping the
// digest makes the fork tier proof reproducible even when :latest moves.
const FOUNDRY_IMAGE = 'ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd';
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const docker = new Docker();

export async function ensureCreate2Proxy(rpcUrl: string): Promise<void> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const existing = await publicClient.getCode({ address: CREATE2_PROXY_ADDRESS });
  if (existing && existing !== '0x') {
    expect(keccak256(existing)).toBe(CREATE2_PROXY_RUNTIME_HASH);
    return;
  }
  const wallet = createWalletClient({ account: privateKeyToAccount(DEV_KEY), transport: http(rpcUrl) });
  const funding = await wallet.sendTransaction({ chain: undefined, to: CREATE2_PROXY_DEPLOYER_ADDRESS, value: 1_000_000_000_000_000_000n });
  await publicClient.waitForTransactionReceipt({ hash: funding });
  const tx = await publicClient.sendRawTransaction({ serializedTransaction: CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  const runtime = await publicClient.getCode({ address: CREATE2_PROXY_ADDRESS });
  expect(runtime).toBeTruthy();
  expect(keccak256(runtime!)).toBe(CREATE2_PROXY_RUNTIME_HASH);
}

async function dockerReady(): Promise<boolean> {
  try { await docker.ping(); return true; } catch { return false; }
}
const ready = await dockerReady();

describe.skipIf(!ready)('plan engine integration fixtures', () => {
  let container: Docker.Container | undefined;
  afterAll(async () => { await container?.stop({ t: 2 }).catch(() => {}); });

  it('installs the canonical CREATE2 proxy on anvil', async () => {
    container = await docker.createContainer({
      Image: FOUNDRY_IMAGE,
      Entrypoint: ['anvil'], Cmd: ['--host', '0.0.0.0', '--chain-id', '31337'],
      ExposedPorts: { '8545/tcp': {} },
      HostConfig: { AutoRemove: true, PortBindings: { '8545/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] } },
    });
    await container.start();
    const port = (await container.inspect()).NetworkSettings.Ports?.['8545/tcp']?.[0]?.HostPort;
    if (!port) throw new Error('anvil did not publish rpc');
    const rpcUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i += 1) {
      try { await createPublicClient({ transport: http(rpcUrl) }).getChainId(); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    await ensureCreate2Proxy(rpcUrl);
  });
});
