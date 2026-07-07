// Per-user RPC endpoint store, keyed by chainId. RPC URLs may embed API
// keys — this file lives under ~/.ignite and its contents must never be
// written into repos or deployment artifacts (SPEC §6.8: provider label only).
import { randomUUID } from 'crypto';
import type { RpcEndpoint, RpcVerificationResult } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { isValidRpcUrl } from './rpcVerify.js';

export interface RpcStoreDeps {
  fileSystem: Pick<
    FileSystem,
    'getRpcStorePath' | 'fileExists' | 'readJsonFile' | 'writeJsonFile'
  >;
  randomUUID: () => string;
}

// { "<chainId>": RpcEndpoint[] }
type RpcStoreFile = Record<string, RpcEndpoint[]>;

export class RpcStore {
  private deps: RpcStoreDeps;

  constructor(deps?: Partial<RpcStoreDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
      randomUUID: deps?.randomUUID ?? randomUUID,
    };
  }

  async list(chainId: number): Promise<RpcEndpoint[]> {
    const file = await this.readFile();
    return file[String(chainId)] ?? [];
  }

  async add(
    chainId: number,
    input: { url: string; label?: string; source?: 'manual' | 'chainlist' }
  ): Promise<RpcEndpoint> {
    const url = input.url.trim();
    if (!isValidRpcUrl(url)) {
      throw Object.assign(
        new Error(`Invalid RPC URL (http/https only): ${url}`),
        { code: 'INVALID_RPC_URL' }
      );
    }
    const file = await this.readFile();
    const key = String(chainId);
    const endpoints = file[key] ?? [];
    if (endpoints.some((e) => e.url === url)) {
      throw Object.assign(
        new Error(`RPC endpoint already exists for chain ${chainId}`),
        { code: 'RPC_ALREADY_EXISTS' }
      );
    }
    const endpoint: RpcEndpoint = {
      id: this.deps.randomUUID(),
      url,
      label: input.label,
      source: input.source ?? 'manual',
      preferred: endpoints.length === 0,
    };
    file[key] = [...endpoints, endpoint];
    await this.writeFile(file);
    return endpoint;
  }

  async remove(chainId: number, endpointId: string): Promise<void> {
    const file = await this.readFile();
    const key = String(chainId);
    const endpoints = file[key] ?? [];
    const target = endpoints.find((e) => e.id === endpointId);
    if (!target) {
      throw Object.assign(
        new Error(`RPC endpoint ${endpointId} not found for chain ${chainId}`),
        { code: 'RPC_NOT_FOUND' }
      );
    }
    const remaining = endpoints.filter((e) => e.id !== endpointId);
    if (target.preferred && remaining.length > 0) {
      remaining[0] = { ...remaining[0], preferred: true };
    }
    if (remaining.length === 0) {
      delete file[key];
    } else {
      file[key] = remaining;
    }
    await this.writeFile(file);
  }

  async setPreferred(
    chainId: number,
    endpointId: string
  ): Promise<RpcEndpoint[]> {
    const file = await this.readFile();
    const key = String(chainId);
    const endpoints = file[key] ?? [];
    if (!endpoints.some((e) => e.id === endpointId)) {
      throw Object.assign(
        new Error(`RPC endpoint ${endpointId} not found for chain ${chainId}`),
        { code: 'RPC_NOT_FOUND' }
      );
    }
    file[key] = endpoints.map((e) => ({
      ...e,
      preferred: e.id === endpointId,
    }));
    await this.writeFile(file);
    return file[key];
  }

  // Best-effort by design: persisting a health result must never fail a
  // verification request (mirrors ProfileRepoRegistry.updateRepoState).
  async updateVerification(
    chainId: number,
    endpointId: string,
    result: RpcVerificationResult
  ): Promise<void> {
    const file = await this.readFile();
    const key = String(chainId);
    const endpoints = file[key] ?? [];
    const idx = endpoints.findIndex((e) => e.id === endpointId);
    if (idx === -1) return;
    endpoints[idx] = { ...endpoints[idx], lastVerification: result };
    file[key] = endpoints;
    await this.writeFile(file);
  }

  private async readFile(): Promise<RpcStoreFile> {
    const p = this.deps.fileSystem.getRpcStorePath();
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        const data = await this.deps.fileSystem.readJsonFile<RpcStoreFile>(p);
        if (data && typeof data === 'object') {
          return data;
        }
      }
    } catch {
      // Corrupt store reads as empty; the next write rebuilds it.
    }
    return {};
  }

  private async writeFile(file: RpcStoreFile): Promise<void> {
    await this.deps.fileSystem.writeJsonFile(
      this.deps.fileSystem.getRpcStorePath(),
      file
    );
  }
}
