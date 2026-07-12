// Regression for the D4-feedback confirm-mapping 404: a chain-derived id can
// be evicted from the merged list by URL dedupe (manual entry wins); PATCHing
// the stale id must retarget the surviving same-URL entry, and unknown ids
// must not strand dead overlays.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExplorerHandlers,
  resolveMergedExplorers,
} from '../../api/explorers.js';
import { ExplorerStore } from '../../chains/ExplorerStore.js';

const SEPOLIA_BLOCKSCOUT = 'https://eth-sepolia.blockscout.com';

function makeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))
  );
});

async function makeHandlers() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-expupd-'));
  dirs.push(dir);
  const store = new ExplorerStore({ baseDir: dir });
  const handlers = createExplorerHandlers({
    registry: {
      getChain: vi.fn(async () => ({
        chainId: 11155111,
        name: 'Ethereum Sepolia',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpc: [],
        source: 'chainlist',
        explorers: [
          { name: 'Blockscout', url: SEPOLIA_BLOCKSCOUT, standard: 'EIP3091' },
        ],
      })),
    } as never,
    store,
    providers: {
      getDetected: vi.fn(async () => ({ entries: [], statuses: [] })),
      getUrlPatternClaims: vi.fn(async () => [
        { pluginId: 'blockscout', patterns: ['blockscout'] },
      ]),
    } as never,
  });
  return { handlers, store };
}

async function chainDerivedId(handlers: {
  listExplorers: (req: never, reply: never) => Promise<unknown>;
}) {
  const reply = makeReply();
  await handlers.listExplorers(
    { query: { chainId: 11155111 } } as never,
    reply as never
  );
  const entries = (reply.body as { data: { entries: { id: string }[] } }).data
    .entries;
  return entries.find((entry) => entry.id.startsWith('chain:'))!.id;
}

describe('updateExplorer retargeting', () => {
  it('retargets a dedupe-evicted chain id to the surviving manual entry', async () => {
    const { handlers, store } = await makeHandlers();
    const staleId = await chainDerivedId(handlers);
    // The same URL is then added manually: manual > chain in dedupe, so the
    // chain-derived row disappears from the merged list.
    const manual = await store.add({
      chainId: 11155111,
      url: SEPOLIA_BLOCKSCOUT,
    });
    const reply = makeReply();
    await handlers.updateExplorer(
      {
        params: { id: staleId },
        body: { verifierPluginId: 'blockscout' },
      } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(200);
    const entry = (reply.body as { data: { entry: { id: string; verifierPluginId?: string } } })
      .data.entry;
    expect(entry.id).toBe(manual.id); // patch landed on the survivor
    expect(entry.verifierPluginId).toBe('blockscout');
  });

  it('404s an unknown derived id without persisting a dead overlay', async () => {
    const { handlers, store } = await makeHandlers();
    const reply = makeReply();
    await handlers.updateExplorer(
      {
        params: { id: `chain:11155111:${'0'.repeat(64)}` },
        body: { verifierPluginId: 'blockscout' },
      } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(404);
    expect(await store.overlays(11155111)).toEqual({});
  });

  it('still updates a live chain-derived id via an overlay', async () => {
    const { handlers } = await makeHandlers();
    const id = await chainDerivedId(handlers);
    const reply = makeReply();
    await handlers.updateExplorer(
      { params: { id }, body: { verifierPluginId: 'blockscout' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(200);
    const entry = (reply.body as { data: { entry: { verifierPluginId?: string } } })
      .data.entry;
    expect(entry.verifierPluginId).toBe('blockscout');
  });
});

describe('resolveMergedExplorers verifier mappings', () => {
  it('auto-confirms an unambiguous URL-pattern match', async () => {
    const { handlers } = await makeHandlers();
    const reply = makeReply();
    await handlers.listExplorers(
      { query: { chainId: 11155111 } } as never,
      reply as never
    );
    const entry = (reply.body as {
      data: { entries: { verifierPluginId?: string; mappingSuggestion?: string }[] };
    }).data.entries[0];
    expect(entry.verifierPluginId).toBe('blockscout');
    expect(entry.mappingSuggestion).toBeUndefined();
  });

  it('keeps ambiguous URL-pattern matches as a suggestion', async () => {
    const { store } = await makeHandlers();
    const entries = await resolveMergedExplorers(
      {
        registry: {
          getChain: vi.fn(async () => ({
            chainId: 11155111,
            explorers: [{ name: 'Blockscout', url: SEPOLIA_BLOCKSCOUT }],
          })),
        } as never,
        store,
        providers: {
          getDetected: vi.fn(async () => ({ entries: [], statuses: [] })),
          getUrlPatternClaims: vi.fn(async () => [
            { pluginId: 'blockscout', patterns: ['blockscout'] },
            { pluginId: 'alternate-blockscout', patterns: ['blockscout'] },
          ]),
        } as never,
      },
      11155111
    );
    expect(entries[0]).toMatchObject({
      mappingSuggestion: 'blockscout',
    });
    expect(entries[0].verifierPluginId).toBeUndefined();
  });

  it('lets an overlay override an auto-confirmed mapping', async () => {
    const { handlers, store } = await makeHandlers();
    const id = await chainDerivedId(handlers);
    await store.update(id, { verifierPluginId: 'alternate-blockscout' });
    const reply = makeReply();
    await handlers.listExplorers(
      { query: { chainId: 11155111 } } as never,
      reply as never
    );
    const entry = (reply.body as {
      data: { entries: { verifierPluginId?: string }[] };
    }).data.entries[0];
    expect(entry.verifierPluginId).toBe('alternate-blockscout');
  });
});
