import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWorkflowHandlers } from '../../api/workflows.js';
import { RepoService } from '../../repos/RepoService.js';
import type { FileSystem } from '../../filesystem/FileSystem.js';
import type { ProfileManager } from '../../filesystem/ProfileManager.js';

const dirs: string[] = [];
let app: FastifyInstance;
let root: string;

function document(url = 'https://example.test/repo.git') {
  return {
    schemaVersion: 1,
    sources: [{ id: 'c', repo: { url, commit: 'a'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/C.sol', contractName: 'C', artifactPath: 'out/C.json' }],
    steps: [{ id: 'deploy', kind: 'deploy', contractId: 'c' }],
    requiredPlugins: [{ id: 'foundry', version: '1.0.0' }],
    outputs: { hooks: [] },
  };
}

async function write(name: string, contents: string): Promise<void> {
  const dir = path.join(root, 'ignite', 'workflows'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), contents);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflows-')); dirs.push(root);
  const repos = new RepoService({ fileSystem: { getReposPath: () => '/unused' } as unknown as FileSystem, profiles: { getCurrentProfile: () => 'p1' } as unknown as ProfileManager });
  const handlers = createWorkflowHandlers({ repos, devMode: () => false });
  app = fastify();
  app.get('/api/v1/repos/workflows', handlers.listWorkflows);
  app.get('/api/v1/repos/workflows/:name', handlers.getWorkflow);
  app.put('/api/v1/repos/workflows/:name', handlers.putWorkflow);
  await app.ready();
});
afterAll(async () => { await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('workflow discovery/read/save API', () => {
  it('lists valid and invalid files, reports oversized entries, and handles a missing directory', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflows-empty-')); dirs.push(emptyRoot);
    expect((await app.inject({ method: 'GET', url: `/api/v1/repos/workflows?pathOrUrl=${encodeURIComponent(emptyRoot)}` })).json()).toEqual({ data: { workflows: [], truncated: false } });
    await write('valid', JSON.stringify(document())); await write('broken', '{bad'); await write('huge', 'x'.repeat(512 * 1024 + 1));
    const response = await app.inject({ method: 'GET', url: `/api/v1/repos/workflows?pathOrUrl=${encodeURIComponent(root)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'valid', valid: true, sourceCount: 1, stepCount: 1 }),
      expect.objectContaining({ name: 'broken', valid: false }),
      expect.objectContaining({ name: 'huge', valid: false, error: expect.stringMatching(/512/) }),
    ]));
  });

  it('caps listing scans at 256 regular files and reports truncation', async () => {
    await Promise.all(Array.from({ length: 257 }, (_, index) => write(`w${index}`, JSON.stringify(document()))));
    const response = await app.inject({ method: 'GET', url: `/api/v1/repos/workflows?pathOrUrl=${encodeURIComponent(root)}` });
    expect(response.json().data.workflows).toHaveLength(256);
    expect(response.json().data.truncated).toBe(true);
  });

  it('returns raw text, parsed document, and a stable sha256 docHash', async () => {
    const raw = `${JSON.stringify(document(), null, 2)}\n`; await write('valid', raw);
    const first = await app.inject({ method: 'GET', url: `/api/v1/repos/workflows/valid?pathOrUrl=${encodeURIComponent(root)}` });
    const second = await app.inject({ method: 'GET', url: `/api/v1/repos/workflows/valid?pathOrUrl=${encodeURIComponent(root)}` });
    expect(first.statusCode).toBe(200); expect(first.json().data.raw).toBe(raw);
    expect(first.json().data.docHash).toMatch(/^[0-9a-f]{64}$/); expect(second.json().data.docHash).toBe(first.json().data.docHash);
  });

  it('creates without CAS, requires CAS for updates, and rejects one of two concurrent stale-base writers', async () => {
    const url = `/api/v1/repos/workflows/valid?pathOrUrl=${encodeURIComponent(root)}`;
    const created = await app.inject({ method: 'PUT', url, payload: { document: document() } });
    expect(created.statusCode).toBe(200);
    const missingCas = await app.inject({ method: 'PUT', url, payload: { document: { ...document(), description: 'missing' } } });
    expect(missingCas.statusCode).toBe(409);
    const baseDocHash = created.json().data.docHash;
    const [one, two] = await Promise.all([
      app.inject({ method: 'PUT', url, payload: { document: { ...document(), description: 'one' }, baseDocHash } }),
      app.inject({ method: 'PUT', url, payload: { document: { ...document(), description: 'two' }, baseDocHash } }),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
  });

  it('rejects unsafe names, ssh pins, and closure violations; file URLs require dev mode', async () => {
    const put = (name: string, doc: unknown) => app.inject({ method: 'PUT', url: `/api/v1/repos/workflows/${name}?pathOrUrl=${encodeURIComponent(root)}`, payload: { document: doc } });
    expect((await put('..%2Fsecret', document())).statusCode).toBe(400);
    expect((await put('ssh', document('ssh://git@example.test/repo.git'))).statusCode).toBe(400);
    expect((await put('closure', { ...document(), requiredPlugins: [] })).statusCode).toBe(400);
    expect((await put('file', document('file:///tmp/repo'))).statusCode).toBe(400);
    await app.close();
    const repos = new RepoService({ fileSystem: { getReposPath: () => '/unused' } as unknown as FileSystem, profiles: { getCurrentProfile: () => 'p1' } as unknown as ProfileManager });
    const handlers = createWorkflowHandlers({ repos, devMode: () => true }); app = fastify(); app.put('/api/v1/repos/workflows/:name', handlers.putWorkflow); await app.ready();
    expect((await put('file', document('file:///tmp/repo'))).statusCode).toBe(200);
  });
});
