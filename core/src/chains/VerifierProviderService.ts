import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { sanitizePluginString } from '../verifications/sanitize.js';
import { getLogger } from '../utils/logger.js';
import { normalizeExplorerUrl } from './ExplorerStore.js';

export type DetectedExplorerEntry = { pluginId: string; chainId: number; url: string; label?: string; pageUrlTemplate?: string };
export type ProviderStatus = { pluginId: string; name: string; state: 'ok' | 'needs-config' | 'error' };
type Cache = { entries: DetectedExplorerEntry[]; patterns: string[]; state: ProviderStatus['state']; ts: number };
const TTL = 5 * 60_000; const TIMEOUT = 30_000;

export class VerifierProviderService {
  private static instance: VerifierProviderService;
  private cache = new Map<string, Cache>(); private inflight = new Map<string, Promise<Cache>>();
  private readonly deps: { getProviders: () => Promise<{id:string;name:string}[]>; execute: (id:string, operation:string, options:Record<string,unknown>, opts?: {signal?:AbortSignal}) => Promise<PluginResponse<unknown>>; now: () => number; timeoutMs: number; logger: {warn(message:string):void} };
  constructor(deps?: Partial<VerifierProviderService['deps']>) { this.deps = { getProviders: deps?.getProviders ?? defaultProviders, execute: deps?.execute ?? defaultExecute, now: deps?.now ?? Date.now, timeoutMs: deps?.timeoutMs ?? TIMEOUT, logger: deps?.logger ?? getLogger() }; }
  static getInstance(): VerifierProviderService { return this.instance ??= new VerifierProviderService(); }
  static resetInstance(): void { this.instance = undefined as unknown as VerifierProviderService; }
  invalidate(pluginId?: string): void { if (pluginId) this.cache.delete(pluginId); else this.cache.clear(); }
  async getDetected(chainId: number): Promise<{ entries: DetectedExplorerEntry[]; statuses: ProviderStatus[] }> { const providers = await this.deps.getProviders(); const all = await Promise.all(providers.map(async (provider) => ({ provider, cache: await this.get(provider.id) }))); return { entries: all.flatMap(({provider,cache}) => cache.entries.filter((entry) => entry.chainId === chainId).map((entry) => ({...entry, pluginId: provider.id}))), statuses: all.map(({provider,cache}) => ({pluginId: provider.id, name: provider.name, state: cache.state})) }; }
  async getUrlPatternClaims(): Promise<{pluginId:string;patterns:string[]}[]> { const providers = await this.deps.getProviders(); return Promise.all(providers.map(async (provider) => ({ pluginId: provider.id, patterns: (await this.get(provider.id)).patterns }))); }
  private async get(id: string): Promise<Cache> { const cached = this.cache.get(id); if (cached && this.deps.now() - cached.ts < TTL) return cached; const active = this.inflight.get(id); if (active) return active; const request = this.fetch(id); this.inflight.set(id, request); try { const value = await request; this.cache.set(id, value); return value; } finally { this.inflight.delete(id); } }
  private async fetch(id: string): Promise<Cache> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs); try { const response = await this.deps.execute(id, 'getSupportedExplorers', {}, { signal: controller.signal }); if (!response.success) { this.deps.logger.warn(`Verifier ${id} discovery failed (${sanitizePluginString(String(response.error.code), 64) ?? ''}): ${sanitizePluginString(response.error.message, 200) ?? ''}`); return {entries:[],patterns:[],state:'error',ts:this.deps.now()}; } const raw = response.data as { explorers?: unknown; urlPatterns?: unknown }; if (!raw || typeof raw !== 'object' || !Array.isArray(raw.urlPatterns)) return {entries:[],patterns:[],state:'error',ts:this.deps.now()}; const patterns = raw.urlPatterns.filter((x): x is string => typeof x === 'string').slice(0, 100); if (raw.explorers === null) return {entries:[],patterns,state:'needs-config',ts:this.deps.now()}; if (!Array.isArray(raw.explorers)) return {entries:[],patterns,state:'error',ts:this.deps.now()}; const entries: DetectedExplorerEntry[] = []; for (const item of raw.explorers.slice(0,500)) { if (!item || typeof item !== 'object') continue; const x = item as {chainId?:unknown;explorerUrl?:unknown;label?:unknown;explorerPageUrlTemplate?:unknown}; if (!Number.isInteger(x.chainId) || (x.chainId as number) <= 0 || typeof x.explorerUrl !== 'string') continue; try { entries.push({pluginId:id,chainId:x.chainId as number,url:normalizeExplorerUrl(x.explorerUrl),...(typeof x.label === 'string' ? {label: sanitizePluginString(x.label, 120)}: {}),...(isPageUrlTemplate(x.explorerPageUrlTemplate) ? {pageUrlTemplate: x.explorerPageUrlTemplate} : {})}); } catch { /* untrusted entry */ } } return {entries,patterns,state:'ok',ts:this.deps.now()}; } catch (error) { this.deps.logger.warn(`Verifier ${id} discovery threw: ${sanitizePluginString(error instanceof Error ? error.message : String(error), 200) ?? ''}`); return {entries:[],patterns:[],state:'error',ts:this.deps.now()}; } finally { clearTimeout(timer); } }
}
async function defaultProviders() { const configs = await PluginRegistryLoader.getInstance().getPluginsByType(PluginType.VERIFIER); return configs.map((config) => ({id:config.metadata.id,name:config.metadata.name})); }
function defaultExecute(id:string, operation:string, options:Record<string,unknown>, opts?:{signal?:AbortSignal}) { return PluginExecutor.getInstance().execute(id, operation, options, { ...opts, chainScope: 'none' }); }

// A page template is a plugin-supplied http(s) URL containing exactly the
// {address} placeholder — anything else is dropped (untrusted input).
function isPageUrlTemplate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false;
  if (!value.includes('{address}')) return false;
  try {
    const url = new URL(value.replace('{address}', '0x0'));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
