// Durable global explorer mappings. Unlike RpcStore, every mutation is
// serialized: a stale read may never overwrite a newer selection or overlay.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystem } from '../filesystem/FileSystem.js';

export interface StoredExplorerEntry {
  id: string;
  chainId: number;
  url: string;
  source: 'manual';
  verifierPluginId?: string;
  apiUrl?: string;
  label?: string;
}

interface ExplorerOverlay {
  verifierPluginId?: string;
  apiUrl?: string;
  label?: string;
}
interface ExplorerStoreFile {
  schemaVersion: 1;
  entries: StoredExplorerEntry[];
  overlays: Record<string, ExplorerOverlay>;
  selectedExplorerIds: Record<string, string[]>;
}

const EMPTY = (): ExplorerStoreFile => ({
  schemaVersion: 1,
  entries: [],
  overlays: {},
  selectedExplorerIds: {},
});

export class ExplorerStore {
  private readonly baseDir: string;
  private readonly fileSystem: Pick<FileSystem, 'getIgniteHome' | 'fileExists' | 'readJsonFile' | 'writeJsonFile'>;
  private chain = Promise.resolve();

  constructor(deps?: { baseDir?: string; randomUUID?: () => string }) {
    this.fileSystem = FileSystem.getInstance();
    this.baseDir = deps?.baseDir ?? this.fileSystem.getIgniteHome();
    this.randomUUID = deps?.randomUUID ?? randomUUID;
  }
  private readonly randomUUID: () => string;

  async list(chainId: number): Promise<StoredExplorerEntry[]> {
    const file = await this.read();
    return file.entries.filter((entry) => entry.chainId === chainId).map((entry) => ({ ...entry }));
  }

  async overlays(chainId: number): Promise<Record<string, ExplorerOverlay>> {
    const file = await this.read();
    const entries = new Set(file.entries.filter((entry) => entry.chainId === chainId).map((entry) => entry.id));
    return Object.fromEntries(Object.entries(file.overlays).filter(([id]) => id.startsWith(`chain:${chainId}:`) || id.includes(`:${chainId}:`) || entries.has(id)).map(([id, value]) => [id, { ...value }]));
  }

  async add(input: { chainId: number; url: string; verifierPluginId?: string; apiUrl?: string; label?: string }): Promise<StoredExplorerEntry> {
    const url = normalizeExplorerUrl(input.url);
    if (input.apiUrl !== undefined) validateExplorerUrl(input.apiUrl);
    return this.mutate((file) => {
      if (file.entries.some((entry) => entry.chainId === input.chainId && normalizeExplorerUrl(entry.url) === url)) throw coded('EXPLORER_ALREADY_EXISTS', `Explorer already exists for chain ${input.chainId}`);
      const entry: StoredExplorerEntry = { id: `manual:${this.randomUUID()}`, chainId: input.chainId, url, source: 'manual', ...(input.verifierPluginId ? { verifierPluginId: input.verifierPluginId } : {}), ...(input.apiUrl ? { apiUrl: normalizeExplorerUrl(input.apiUrl) } : {}), ...(input.label ? { label: input.label } : {}) };
      file.entries.push(entry);
      return entry;
    });
  }

  async update(id: string, patch: { url?: string; verifierPluginId?: string; apiUrl?: string; label?: string }): Promise<StoredExplorerEntry | ExplorerOverlay> {
    if (patch.url !== undefined) validateExplorerUrl(patch.url);
    if (patch.apiUrl !== undefined) validateExplorerUrl(patch.apiUrl);
    return this.mutate((file) => {
      const index = file.entries.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        const entry = file.entries[index];
        const next = { ...entry, ...(patch.url === undefined ? {} : { url: normalizeExplorerUrl(patch.url) }), ...(patch.verifierPluginId === undefined ? {} : { verifierPluginId: patch.verifierPluginId }), ...(patch.apiUrl === undefined ? {} : { apiUrl: normalizeExplorerUrl(patch.apiUrl) }), ...(patch.label === undefined ? {} : { label: patch.label }) };
        file.entries[index] = next;
        return next;
      }
      if (patch.url !== undefined) throw coded('EXPLORER_URL_IMMUTABLE', 'Only manual explorer URLs can be edited');
      const next = { ...(file.overlays[id] ?? {}), ...(patch.verifierPluginId === undefined ? {} : { verifierPluginId: patch.verifierPluginId }), ...(patch.apiUrl === undefined ? {} : { apiUrl: normalizeExplorerUrl(patch.apiUrl) }), ...(patch.label === undefined ? {} : { label: patch.label }) };
      file.overlays[id] = next;
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((file) => {
      const index = file.entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw coded('EXPLORER_NOT_FOUND', `Explorer ${id} not found`);
      file.entries.splice(index, 1);
      delete file.overlays[id];
      for (const key of Object.keys(file.selectedExplorerIds)) file.selectedExplorerIds[key] = file.selectedExplorerIds[key].filter((selected) => selected !== id);
    });
  }

  async getSelection(chainId: number): Promise<string[]> { return [...((await this.read()).selectedExplorerIds[String(chainId)] ?? [])]; }
  async setSelection(chainId: number, ids: string[]): Promise<void> { await this.mutate((file) => { file.selectedExplorerIds[String(chainId)] = [...new Set(ids)]; }); }

  private filePath(): string { return path.join(this.baseDir, 'explorers.json'); }
  private async read(): Promise<ExplorerStoreFile> {
    const file = this.filePath();
    if (!(await this.fileSystem.fileExists(file))) return EMPTY();
    try {
      const value = await this.fileSystem.readJsonFile<unknown>(file);
      if (!isFile(value)) throw new Error('invalid explorer store schema');
      return value;
    } catch {
      await fs.rename(file, `${file}.bad`).catch(() => undefined);
      return EMPTY();
    }
  }
  private async mutate<T>(operation: (file: ExplorerStoreFile) => T): Promise<T> {
    const run = this.chain.catch(() => undefined).then(async () => {
      const file = await this.read();
      const result = operation(file);
      await this.fileSystem.writeJsonFile(this.filePath(), file);
      return result;
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function validateExplorerUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw coded('INVALID_EXPLORER_URL', 'Explorer URL must be http(s)'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw coded('INVALID_EXPLORER_URL', 'Explorer URL must be http(s)');
  if (url.username || url.password) throw coded('EXPLORER_URL_CREDENTIALS', 'Explorer URLs may not include credentials');
}
export function normalizeExplorerUrl(value: string): string {
  validateExplorerUrl(value);
  const url = new URL(value.trim());
  url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '') || '';
  return url.toString().replace(/\/$/, '');
}
export function explorerUrlHash(url: string): string { return createHash('sha256').update(normalizeExplorerUrl(url)).digest('hex'); }
function isFile(value: unknown): value is ExplorerStoreFile { return !!value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 1 && Array.isArray((value as { entries?: unknown }).entries) && typeof (value as { overlays?: unknown }).overlays === 'object' && typeof (value as { selectedExplorerIds?: unknown }).selectedExplorerIds === 'object'; }
function coded(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
