import Docker from 'dockerode';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicClient, http, type Hex } from 'viem';
import type { ScheduleEntry } from './schedule.js';

const IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const LABEL = 'ignite-simfork';
const MAX_FORKS = 2;
let inUse = 0;

export interface ForkRunner {
  run(schedule: ScheduleEntry[]): Promise<
    Record<
      string,
      {
        gasUsed: string;
        status: 'ok' | 'reverted';
        reason?: string;
        createdAddress?: Hex;
      }
    >
  >;
}

export interface ForkDocker {
  inspectImage(name: string): Promise<unknown>;
  createContainer(
    options: Docker.ContainerCreateOptions
  ): Promise<Docker.Container>;
  getContainer(id: string): Docker.Container;
  listContainers(
    options: Docker.ContainerListOptions
  ): Promise<Array<{ Id: string }>>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function acquire(): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (inUse >= MAX_FORKS) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  inUse += 1;
  return true;
}
const release = () => {
  inUse = Math.max(0, inUse - 1);
};

async function portOf(container: Docker.Container): Promise<number> {
  const inspect = await container.inspect();
  const ports = inspect.NetworkSettings?.Ports?.['8545/tcp'];
  const port = Array.isArray(ports) ? ports[0]?.HostPort : undefined;
  if (!port) throw new Error('Fork container did not expose anvil port');
  return Number(port);
}

async function waitForRpc(url: string): Promise<void> {
  const client = createPublicClient({ transport: http(url) });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await client.getBlockNumber();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(200);
    }
  }
}

function hex(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

export async function makeForkRunner(
  opts: { rpcUrl: string; chainId: number },
  deps?: { docker?: ForkDocker }
): Promise<ForkRunner | undefined> {
  const rawDocker = new Docker();
  const docker: ForkDocker = deps?.docker ?? {
    inspectImage: (name) => rawDocker.getImage(name).inspect(),
    createContainer: (options) => rawDocker.createContainer(options),
    getContainer: (id) => rawDocker.getContainer(id),
    listContainers: (options) =>
      rawDocker.listContainers(options) as Promise<Array<{ Id: string }>>,
  };
  try {
    await docker.inspectImage(IMAGE);
  } catch {
    return undefined;
  }
  if (!(await acquire())) return undefined;
  let container: Docker.Container | undefined;
  let urlFile: string | undefined;
  try {
    // The fork URL may carry credentials, and BOTH argv and Env surface in
    // `docker inspect` (final-review F2) — so the URL rides a 0600 host
    // tmpfile bind-mounted read-only; inspect shows only the mount path.
    // Loopback hosts are rewritten to the host gateway (inside the container
    // 127.0.0.1 is the container itself).
    const forkUrl = opts.rpcUrl.replace(/127\.0\.0\.1|localhost/, 'host.docker.internal');
    urlFile = path.join(os.tmpdir(), `ignite-simfork-${crypto.randomUUID()}`);
    await fs.writeFile(urlFile, forkUrl, { mode: 0o600 });
    container = await docker.createContainer({
      Image: IMAGE,
      Labels: { [LABEL]: '1' },
      // The foundry image's default entrypoint wraps Cmd; override it or the
      // shell invocation never runs (container exits, RPC never comes up).
      Entrypoint: ['sh', '-c'],
      Cmd: ['anvil --fork-url "$(cat /run/ignite-fork-url)" --host 0.0.0.0 --port 8545'],
      HostConfig: {
        AutoRemove: true,
        PortBindings: { '8545/tcp': [{ HostPort: '' }] },
        Binds: [`${urlFile}:/run/ignite-fork-url:ro`],
        // Linux needs the explicit host-gateway mapping; Docker Desktop
        // resolves host.docker.internal natively and tolerates the extra host.
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
      ExposedPorts: { '8545/tcp': {} },
    });
    await container.start();
    const url = `http://127.0.0.1:${await portOf(container)}`;
    await waitForRpc(url);
    const owned = container;
    return {
      async run(schedule) {
        const client = createPublicClient({ transport: http(url) });
        const deadline = Date.now() + 120_000;
        const receipts: Record<
          string,
          {
            gasUsed: string;
            status: 'ok' | 'reverted';
            reason?: string;
            createdAddress?: Hex;
          }
        > = {};
        try {
          for (const entry of schedule) {
            if (entry.kind === 'existing') continue;
            if (!entry.from || !entry.data || entry.value === undefined)
              throw new Error(`Schedule entry ${entry.stepId} is incomplete`);
            const rpc = client as unknown as {
              request(args: {
                method: string;
                params: unknown[];
              }): Promise<unknown>;
            };
            await rpc.request({
              method: 'anvil_impersonateAccount',
              params: [entry.from],
            });
            await rpc.request({
              method: 'anvil_setBalance',
              params: [entry.from, hex(10n ** 24n)],
            });
            const hash = (await rpc.request({
              method: 'eth_sendTransaction',
              params: [
                {
                  from: entry.from,
                  ...(entry.to ? { to: entry.to } : {}),
                  data: entry.data,
                  value: hex(entry.value),
                },
              ],
            })) as Hex;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Fork simulation timed out');
            const receipt = await client.waitForTransactionReceipt({
              hash,
              timeout: remaining,
            });
            receipts[entry.stepId] = {
              gasUsed: receipt.gasUsed.toString(),
              status: receipt.status === 'success' ? 'ok' : 'reverted',
              ...(receipt.contractAddress
                ? { createdAddress: receipt.contractAddress }
                : {}),
            };
          }
          return receipts;
        } finally {
          try {
            await owned.stop({ t: 1 });
          } finally {
            release();
            if (urlFile) await fs.rm(urlFile, { force: true }).catch(() => {});
          }
        }
      },
    };
  } catch {
    if (container) {
      try {
        await container.stop({ t: 1 });
      } catch {
        /* AutoRemove may already have removed it. */
      }
    }
    release();
    if (urlFile) await fs.rm(urlFile, { force: true }).catch(() => {});
    return undefined;
  }
}

export async function sweepForkContainers(deps?: {
  docker?: ForkDocker;
}): Promise<void> {
  const rawDocker = new Docker();
  const docker: ForkDocker = deps?.docker ?? {
    inspectImage: (name) => rawDocker.getImage(name).inspect(),
    createContainer: (options) => rawDocker.createContainer(options),
    getContainer: (id) => rawDocker.getContainer(id),
    listContainers: (options) =>
      rawDocker.listContainers(options) as Promise<Array<{ Id: string }>>,
  };
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=1`] },
    });
    await Promise.all(
      containers.map(async ({ Id }) => {
        try {
          await docker.getContainer(Id).remove({ force: true });
        } catch {
          /* sweep is best-effort */
        }
      })
    );
  } catch {
    // Docker being unavailable must never prevent core startup.
  }
}
