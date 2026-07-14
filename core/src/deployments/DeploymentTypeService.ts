import type { DeploymentTypeInfo } from '@ignite/api';
import { CREATE2_PROXY_ADDRESS } from '@ignite/api';
import { PluginType, type PluginResponse } from '@ignite/plugin-types/types';
import { PluginRegistryLoader, type PluginConfig } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { effectiveOperations } from '../plugins/operationBaselines.js';
import { IgniteError } from '../types/errors.js';
import { sanitizePluginString } from '../verifications/sanitize.js';

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
// eslint-disable-next-line no-control-regex -- boundary sanitization needs the literal control range
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

type Provider = PluginConfig;
type Execute = (id: string, operation: string, options: Record<string, unknown>, opts: { chainScope: number | 'none' }) => Promise<PluginResponse<unknown>>;
export interface DeploymentTypeServiceDeps { getProviders: () => Promise<Provider[]>; execute: Execute; }

const text = (value: unknown, cap: number): string | undefined => {
  const output = sanitizePluginString(value, cap + 1);
  return output === undefined || output.length > cap ? undefined : output;
};
const serializedBytes = (value: unknown): number | undefined => { try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return undefined; } };

export class DeploymentTypeService {
  private static instance: DeploymentTypeService;
  private cache?: Promise<DeploymentTypeInfo[]>;
  private readonly deps: DeploymentTypeServiceDeps;

  constructor(deps?: Partial<DeploymentTypeServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? (async () => PluginRegistryLoader.getInstance().getPluginsByType(PluginType.DEPLOYMENT_TYPE)),
      execute: deps?.execute ?? ((id, operation, options, opts) => PluginExecutor.getInstance().execute(id, operation, options, opts)),
    };
  }
  static getInstance(): DeploymentTypeService { return this.instance ??= new DeploymentTypeService(); }
  static resetInstance(): void { this.instance = undefined as unknown as DeploymentTypeService; }
  invalidate(): void { this.cache = undefined; }

  async list(refresh = false): Promise<DeploymentTypeInfo[]> {
    if (refresh || !this.cache) this.cache = this.describeAll();
    return this.cache;
  }

  async prepare(pluginId: string, input: { chainId: number; initcode: `0x${string}`; runtimeBytecode?: `0x${string}`; params?: Record<string, unknown> }): Promise<{ salt: `0x${string}`; predictedAddress: `0x${string}`; notes: string[] }> {
    this.validateInput(input);
    const info = await this.getInfo(pluginId);
    this.assertParamKeys(info, input.params);
    const result = await this.execute(pluginId, 'prepareDeployment', { ...input, proxyAddress: CREATE2_PROXY_ADDRESS }, input.chainId);
    const parsed = this.parsePrepare(result);
    return parsed;
  }

  async validate(pluginId: string, input: { chainId: number; initcode: `0x${string}`; runtimeBytecode?: `0x${string}`; salt: `0x${string}`; predictedAddress: `0x${string}`; params?: Record<string, unknown> }): Promise<{ ok: boolean; reason?: string }> {
    this.validateInput(input);
    if (!HEX32.test(input.salt) || !ADDRESS.test(input.predictedAddress)) this.failed('validateDeployment returned or received invalid address data');
    const info = await this.getInfo(pluginId);
    this.assertParamKeys(info, input.params);
    const result = await this.execute(pluginId, 'validateDeployment', input, input.chainId);
    if (!result || typeof result !== 'object') this.failed('validateDeployment returned an invalid result');
    if (Object.keys(result as object).some((key) => !['ok', 'reason'].includes(key))) this.failed('validateDeployment returned unexpected fields');
    const value = result as Record<string, unknown>;
    if (typeof value.ok !== 'boolean') this.failed('validateDeployment returned an invalid result');
    const reason = value.reason === undefined ? undefined : text(value.reason, 500);
    if (value.reason !== undefined && reason === undefined) this.failed('validateDeployment returned an invalid reason');
    return reason === undefined ? { ok: value.ok } : { ok: value.ok, reason };
  }

  private async describeAll(): Promise<DeploymentTypeInfo[]> {
    const providers = await this.deps.getProviders();
    return Promise.all(providers.map(async (provider) => {
      const raw = await this.execute(provider.metadata.id, 'describeDeploymentType', {}, 'none');
      const described = this.parseDescribe(raw);
      return { pluginId: provider.metadata.id, ...described, validateSupported: effectiveOperations(provider.metadata).includes('validateDeployment') };
    }));
  }
  private async getInfo(pluginId: string): Promise<DeploymentTypeInfo> {
    const info = (await this.list()).find((entry) => entry.pluginId === pluginId);
    if (!info) throw new IgniteError(`Deployment-type plugin ${pluginId} is not installed`, 'PLUGIN_NOT_FOUND');
    return info;
  }
  private async execute(pluginId: string, operation: string, options: Record<string, unknown>, chainScope: number | 'none'): Promise<unknown> {
    let response: PluginResponse<unknown>;
    try { response = await this.deps.execute(pluginId, operation, options, { chainScope }); }
    catch (error) { this.failed(`${operation} failed: ${text(error instanceof Error ? error.message : String(error), 300) ?? 'plugin error'}`); }
    // Plugin-authored messages are untrusted and this error may persist into
    // validation items/artifacts — cap + control-strip (final-review F5).
    if (!response!.success) {
      const code = typeof response!.error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(response!.error.code) ? ` [${response!.error.code}]` : '';
      this.failed(`${operation} failed${code}: ${text(response!.error.message, 300) ?? 'plugin error'}`);
    }
    return response!.data;
  }
  private parseDescribe(raw: unknown): Omit<DeploymentTypeInfo, 'pluginId' | 'validateSupported'> {
    if (!raw || typeof raw !== 'object') this.failed('describeDeploymentType returned an invalid result');
    const value = raw as Record<string, unknown>;
    const label = text(value.label, 64); const description = text(value.description, 512);
    if (!label || !description || !Array.isArray(value.params) || value.params.length > 16) this.failed('describeDeploymentType returned invalid fields');
    const params = value.params.map((field) => this.parseParam(field));
    return { label: label!, description: description!, params };
  }
  private parseParam(raw: unknown): DeploymentTypeInfo['params'][number] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) this.failed('describeDeploymentType returned an invalid param');
    const field = raw as Record<string, unknown>;
    const key = field.key; const label = text(field.label, 280); const description = field.description === undefined ? undefined : text(field.description, 280);
    if (typeof key !== 'string' || !KEY.test(key) || key.length > 64 || !label || !['string', 'number', 'boolean', 'select'].includes(field.type as string) || (field.required !== undefined && typeof field.required !== 'boolean') || (field.description !== undefined && !description)) this.failed('describeDeploymentType returned an invalid param');
    let options: Array<{value:string;label:string}> | undefined;
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 64) this.failed('describeDeploymentType returned invalid select options');
      options = field.options.map((option) => {
        if (!option || typeof option !== 'object') this.failed('describeDeploymentType returned invalid select options');
        const value = (option as Record<string, unknown>).value; const optionLabel = text((option as Record<string, unknown>).label, 280);
        if (typeof value !== 'string' || value.length === 0 || value.length > 280 || CONTROL.test(value) || !optionLabel) this.failed('describeDeploymentType returned invalid select options');
        return { value, label: optionLabel! };
      });
    } else if (field.options !== undefined) this.failed('describeDeploymentType returned unexpected options');
    return { key, label: label!, type: field.type as 'string' | 'number' | 'boolean' | 'select', ...(options ? { options } : {}), ...(field.required === undefined ? {} : { required: field.required as boolean }), ...(description === undefined ? {} : { description }) };
  }
  private parsePrepare(raw: unknown): { salt: `0x${string}`; predictedAddress: `0x${string}`; notes: string[] } {
    if (!raw || typeof raw !== 'object') this.failed('prepareDeployment returned an invalid result');
    if (Object.keys(raw as object).some((key) => !['salt', 'predictedAddress', 'notes'].includes(key))) this.failed('prepareDeployment returned unexpected fields');
    const value = raw as Record<string, unknown>;
    if (typeof value.salt !== 'string' || !HEX32.test(value.salt) || typeof value.predictedAddress !== 'string' || !ADDRESS.test(value.predictedAddress) || (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.length > 8))) this.failed('prepareDeployment returned invalid fields');
    const notes = (value.notes ?? []).map((note) => { const result = text(note, 256); if (result === undefined) this.failed('prepareDeployment returned an invalid note'); return result!; });
    return { salt: value.salt as `0x${string}`, predictedAddress: value.predictedAddress as `0x${string}`, notes };
  }
  private validateInput(input: { chainId: number; initcode: string; runtimeBytecode?: string; params?: Record<string, unknown> }): void {
    if (!Number.isInteger(input.chainId) || input.chainId <= 0 || !HEX.test(input.initcode) || (input.initcode.length - 2) / 2 > 1024 * 1024 || (input.runtimeBytecode !== undefined && (!HEX.test(input.runtimeBytecode) || (input.runtimeBytecode.length - 2) / 2 > 1024 * 1024)) || (input.params !== undefined && (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params) || (serializedBytes(input.params) ?? Infinity) > 64 * 1024))) this.failed('Deployment-type input is invalid');
  }
  private assertParamKeys(info: DeploymentTypeInfo, params: Record<string, unknown> | undefined): void {
    for (const key of Object.keys(params ?? {})) if (!info.params.some((field) => field.key === key)) throw new IgniteError(`Unknown deployment-type parameter '${key}'`, 'UNKNOWN_PARAM_KEY');
    // Strict contract validation (final-review F4): required fields present,
    // primitive types exact, select values from the declared option set.
    for (const field of info.params) {
      const value = params?.[field.key];
      if (value === undefined || value === '') {
        if (field.required) throw new IgniteError(`Deployment-type parameter '${field.key}' is required`, 'INVALID_PARAM_VALUE', { key: field.key });
        continue;
      }
      const bad = (reason: string): never => { throw new IgniteError(`Deployment-type parameter '${field.key}' ${reason}`, 'INVALID_PARAM_VALUE', { key: field.key }); };
      if (field.type === 'string' && typeof value !== 'string') bad('must be a string');
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) bad('must be a finite number');
      if (field.type === 'boolean' && typeof value !== 'boolean') bad('must be a boolean');
      if (field.type === 'select' && !(field.options ?? []).some((option) => option.value === value)) bad('must be one of the declared options');
    }
  }
  private failed(message: string): never { throw new IgniteError(message, 'DEPLOYMENT_TYPE_OP_FAILED'); }
}
