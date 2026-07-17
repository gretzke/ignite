import crypto from 'node:crypto';
import {
  type ContractTypeInfo,
  type FrozenContractType,
  type NormalizedContractTypeDescriptor,
  type ParsedContractArtifact,
} from '@ignite/api';
import { parseAbiItem, parseAbiParameters, toFunctionSignature } from 'viem';
import { PluginType, type PluginResponse } from '@ignite/plugin-types/types';
import { PluginRegistryLoader, type PluginConfig } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { TrustManager } from '../plugins/trust/TrustManager.js';
import { IgniteError } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';
import { sanitizePluginString } from '../verifications/sanitize.js';

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const ABI_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SOURCE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
type Provider = PluginConfig;
type Execute = (id: string, operation: string, options: Record<string, unknown>, opts: { chainScope: number | 'none' }) => Promise<PluginResponse<unknown>>;
export interface ContractTypeServiceDeps {
  getProviders: () => Promise<Provider[]>;
  execute: Execute;
  getGrant: (pluginId: string) => Promise<{ contractBytecode?: boolean }>;
}

const text = (value: unknown, cap: number): string | undefined => {
  const output = sanitizePluginString(value, cap + 1);
  return output === undefined || output.length > cap ? undefined : output;
};
const jsonBytes = (value: unknown): number | undefined => { try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return undefined; } };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function canonicalContractTypeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContractTypeJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalContractTypeJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function contractTypeContentHash(value: Omit<FrozenContractType, 'contentHash'>): string {
  return crypto.createHash('sha256').update(canonicalContractTypeJson(value)).digest('hex');
}

export class ContractTypeService {
  private static instance: ContractTypeService;
  private cache?: Promise<ContractTypeInfo[]>;
  private readonly artifacts = new Map<string, Promise<ParsedContractArtifact>>();
  private readonly frozen = new Map<string, Promise<FrozenContractType>>();
  private readonly deps: ContractTypeServiceDeps;

  constructor(deps?: Partial<ContractTypeServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? (async () => PluginRegistryLoader.getInstance().getPluginsByType(PluginType.CONTRACT_TYPE)),
      execute: deps?.execute ?? ((id, operation, options, opts) => PluginExecutor.getInstance().execute(id, operation, options, opts)),
      getGrant: deps?.getGrant ?? ((pluginId) => TrustManager.getInstance().getGrant(pluginId)),
    };
  }
  static getInstance(): ContractTypeService { return this.instance ??= new ContractTypeService(); }
  static resetInstance(): void { this.instance = undefined as unknown as ContractTypeService; }
  invalidate(): void { this.cache = undefined; this.artifacts.clear(); this.frozen.clear(); }

  async list(refresh = false): Promise<ContractTypeInfo[]> {
    if (refresh || !this.cache) this.cache = this.describeAll();
    return this.cache;
  }

  async getArtifact(pluginId: string, artifactKey: string): Promise<ParsedContractArtifact> {
    await this.assertBytecodeGrant(pluginId);
    if (!KEY.test(artifactKey) || artifactKey.length > 64) this.failed('getContractArtifact received an invalid artifact key');
    const info = await this.getInfo(pluginId);
    if (!info.artifacts.includes(artifactKey)) throw new IgniteError(`Unknown contract-type artifact '${artifactKey}'`, 'ARTIFACT_NOT_FOUND');
    const cacheKey = `${pluginId}\u0000${artifactKey}`;
    let result = this.artifacts.get(cacheKey);
    if (!result) {
      result = this.execute(pluginId, 'getContractArtifact', { artifactKey }, 'none').then((raw) => this.parseArtifact(raw));
      this.artifacts.set(cacheKey, result);
    }
    return result;
  }

  async frozenDescriptor(pluginId: string): Promise<FrozenContractType> {
    await this.assertBytecodeGrant(pluginId);
    let result = this.frozen.get(pluginId);
    if (!result) {
      result = (async () => {
        const descriptor = await this.getInfo(pluginId);
        const artifacts = Object.fromEntries(await Promise.all(descriptor.artifacts.map(async (key) => [key, await this.getArtifact(pluginId, key)] as const)));
        this.validateDescriptor(descriptor, artifacts);
        const unfrozen = { pluginId, versionLabel: descriptor.versionLabel, descriptor: omitPluginId(descriptor), artifacts };
        return { ...unfrozen, contentHash: contractTypeContentHash(unfrozen) };
      })();
      this.frozen.set(pluginId, result);
    }
    return result;
  }

  private async describeAll(): Promise<ContractTypeInfo[]> {
    const providers = await this.deps.getProviders();
    // One hostile or broken provider must not poison the whole cached list
    // (and with it the wizard dropdown) — isolate failures per plugin.
    const settled = await Promise.allSettled(providers.map(async (provider) => ({ pluginId: provider.metadata.id, ...this.parseDescribe(await this.execute(provider.metadata.id, 'describeContractType', {}, 'none')) })));
    return settled.flatMap((entry, index) => {
      if (entry.status === 'fulfilled') return [entry.value];
      getLogger().warn(`contract-type describe failed for ${providers[index]?.metadata.id}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`);
      return [];
    });
  }
  private async getInfo(pluginId: string): Promise<ContractTypeInfo> {
    const entry = (await this.list()).find((item) => item.pluginId === pluginId);
    if (entry) return entry;
    // list() drops providers whose describe failed so one broken plugin
    // cannot poison the dropdown; a direct lookup should still surface that
    // plugin's actual parse error rather than a generic not-installed.
    const provider = (await this.deps.getProviders()).find((item) => item.metadata.id === pluginId);
    if (!provider) throw new IgniteError(`Contract-type plugin ${pluginId} is not installed`, 'PLUGIN_NOT_FOUND');
    return { pluginId, ...this.parseDescribe(await this.execute(pluginId, 'describeContractType', {}, 'none')) };
  }
  private async assertBytecodeGrant(pluginId: string): Promise<void> {
    if ((await this.deps.getGrant(pluginId)).contractBytecode !== true) {
      throw new IgniteError(`Contract-type plugin ${pluginId} is not granted contract bytecode permission`, 'CONTRACT_BYTECODE_NOT_GRANTED');
    }
  }
  private async execute(pluginId: string, operation: string, options: Record<string, unknown>, chainScope: number | 'none'): Promise<unknown> {
    let response: PluginResponse<unknown>;
    try { response = await this.deps.execute(pluginId, operation, options, { chainScope }); }
    catch (error) { this.failed(`${operation} failed: ${text(error instanceof Error ? error.message : String(error), 300) ?? 'plugin error'}`); }
    if (!response!.success) {
      const code = typeof response!.error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(response!.error.code) ? ` [${response!.error.code}]` : '';
      this.failed(`${operation} failed${code}: ${text(response!.error.message, 300) ?? 'plugin error'}`);
    }
    return response!.data;
  }
  private parseDescribe(raw: unknown): Omit<ContractTypeInfo, 'pluginId'> {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !['label', 'description', 'versionLabel', 'params', 'artifacts', 'synthesis', 'validation', 'capture'].includes(key))) this.failed('describeContractType returned an invalid result');
    const label = text(raw.label, 64); const description = text(raw.description, 512); const versionLabel = text(raw.versionLabel, 128);
    if (!label || !description || !versionLabel || !Array.isArray(raw.params) || raw.params.length > 16 || !Array.isArray(raw.artifacts) || raw.artifacts.length > 8 || !Array.isArray(raw.capture) || raw.capture.length > 8 || !isRecord(raw.validation)) this.failed('describeContractType returned invalid fields');
    const params = raw.params.map((param) => this.parseParam(param));
    const artifacts = raw.artifacts.map((key) => this.key(key, 'artifact'));
    if (new Set(artifacts).size !== artifacts.length || new Set(params.map((param) => param.key)).size !== params.length) this.failed('describeContractType returned duplicate keys');
    const synthesis = raw.synthesis === null ? null : this.parseSynthesis(raw.synthesis);
    const validation = this.parseValidation(raw.validation);
    const capture = raw.capture.map((entry) => this.parseCapture(entry));
    return { label, description, versionLabel, params, artifacts, synthesis, validation, capture };
  }
  private parseParam(raw: unknown): NormalizedContractTypeDescriptor['params'][number] {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !['key', 'label', 'type', 'options', 'required', 'description'].includes(key))) this.failed('describeContractType returned an invalid param');
    const key = this.key(raw.key, 'parameter'); const label = text(raw.label, 280); const description = raw.description === undefined ? undefined : text(raw.description, 280);
    if (!label || !['string', 'number', 'boolean', 'select', 'address'].includes(raw.type as string) || (raw.required !== undefined && typeof raw.required !== 'boolean') || (raw.description !== undefined && !description)) this.failed('describeContractType returned an invalid param');
    let options: Array<{ value: string; label: string }> | undefined;
    if (raw.type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 64) this.failed('describeContractType returned invalid select options');
      options = raw.options.map((option) => {
        if (!isRecord(option)) this.failed('describeContractType returned invalid select options');
        const value = option.value; const optionLabel = text(option.label, 280);
        if (typeof value !== 'string' || value.length === 0 || value.length > 280 || CONTROL.test(value) || !optionLabel) this.failed('describeContractType returned invalid select options');
        return { value, label: optionLabel };
      });
    } else if (raw.options !== undefined) this.failed('describeContractType returned unexpected options');
    return { key, label, type: raw.type as NormalizedContractTypeDescriptor['params'][number]['type'], ...(options ? { options } : {}), ...(raw.required === undefined ? {} : { required: raw.required as boolean }), ...(description ? { description } : {}) };
  }
  private parseSynthesis(raw: unknown): NormalizedContractTypeDescriptor['synthesis'] {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !['artifact', 'constructorArgs'].includes(key)) || !Array.isArray(raw.constructorArgs) || raw.constructorArgs.length > 16) this.failed('describeContractType returned an invalid synthesis');
    const constructorArgs = raw.constructorArgs.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !ABI_NAME.test(entry.name) || entry.name.length > 64 || !['implementation', 'param', 'initializer'].includes(entry.from as string)) this.failed('describeContractType returned an invalid synthesis argument');
      if (entry.from === 'param') { if (typeof entry.param !== 'string' || !KEY.test(entry.param) || Object.keys(entry).length !== 3) this.failed('describeContractType returned an invalid synthesis argument'); return { name: entry.name, from: 'param' as const, param: entry.param }; }
      if (Object.keys(entry).length !== 2) this.failed('describeContractType returned an invalid synthesis argument');
      return { name: entry.name, from: entry.from as 'implementation' | 'initializer' };
    });
    if (new Set(constructorArgs.map((arg) => arg.name)).size !== constructorArgs.length) this.failed('describeContractType returned duplicate synthesis arguments');
    return { artifact: this.key(raw.artifact, 'artifact'), constructorArgs } as NormalizedContractTypeDescriptor['synthesis'];
  }
  private parseValidation(raw: Record<string, unknown>): NormalizedContractTypeDescriptor['validation'] {
    if (Object.keys(raw).some((key) => !['requiredFunctions', 'probe', 'warnings'].includes(key))) this.failed('describeContractType returned invalid validation');
    const requiredFunctions = raw.requiredFunctions === undefined ? undefined : this.parseFunctions(raw.requiredFunctions, 16);
    let probe: { call: string; expectReturn: `0x${string}` } | undefined;
    if (raw.probe !== undefined) { if (!isRecord(raw.probe) || Object.keys(raw.probe).some((key) => !['call', 'expectReturn'].includes(key)) || typeof raw.probe.expectReturn !== 'string' || !HEX.test(raw.probe.expectReturn) || (raw.probe.expectReturn.length - 2) / 2 > 1024) this.failed('describeContractType returned invalid probe'); probe = { call: this.parseFunction(raw.probe.call), expectReturn: raw.probe.expectReturn as `0x${string}` }; }
    let warnings: Array<{ when: 'impl-has-function'; fn: string; message: string }> | undefined;
    if (raw.warnings !== undefined) { if (!Array.isArray(raw.warnings) || raw.warnings.length > 16) this.failed('describeContractType returned invalid warnings'); warnings = raw.warnings.map((warning) => { if (!isRecord(warning) || Object.keys(warning).some((key) => !['when', 'fn', 'message'].includes(key)) || warning.when !== 'impl-has-function') this.failed('describeContractType returned invalid warnings'); const message = text(warning.message, 512); if (!message) this.failed('describeContractType returned invalid warnings'); return { when: 'impl-has-function' as const, fn: this.parseFunction(warning.fn), message }; }); }
    return { ...(requiredFunctions ? { requiredFunctions } : {}), ...(probe ? { probe } : {}), ...(warnings ? { warnings } : {}) };
  }
  private parseCapture(raw: unknown): NormalizedContractTypeDescriptor['capture'][number] {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !['slot', 'record', 'expect', 'derivedCreate', 'expectCodeOf', 'verifyAs', 'constructorArgs', 'assertCalls'].includes(key)) || typeof raw.slot !== 'string' || !HEX32.test(raw.slot)) this.failed('describeContractType returned invalid capture');
    const optionalKey = (name: 'record' | 'expectCodeOf' | 'verifyAs') => raw[name] === undefined ? undefined : this.key(raw[name], name);
    if (raw.expect !== undefined && raw.expect !== 'implementation-address') this.failed('describeContractType returned invalid capture');
    let derivedCreate: { nonce: number } | undefined;
    if (raw.derivedCreate !== undefined) { if (!isRecord(raw.derivedCreate) || Object.keys(raw.derivedCreate).length !== 1 || !Number.isSafeInteger(raw.derivedCreate.nonce) || (raw.derivedCreate.nonce as number) < 0) this.failed('describeContractType returned invalid capture'); derivedCreate = { nonce: raw.derivedCreate.nonce as number }; }
    const constructorArgs = raw.constructorArgs === undefined ? undefined : this.keys(raw.constructorArgs, 16, 'constructor argument');
    let assertCalls: Array<{ call: string; on: string; expectParam: string }> | undefined;
    if (raw.assertCalls !== undefined) { if (!Array.isArray(raw.assertCalls) || raw.assertCalls.length > 4) this.failed('describeContractType returned invalid assertCalls'); assertCalls = raw.assertCalls.map((entry) => { if (!isRecord(entry) || Object.keys(entry).some((key) => !['call', 'on', 'expectParam'].includes(key))) this.failed('describeContractType returned invalid assertCalls'); return { call: this.parseFunction(entry.call), on: this.key(entry.on, 'assertCall target'), expectParam: this.key(entry.expectParam, 'assertCall parameter') }; }); }
    return { slot: raw.slot as `0x${string}`, ...(optionalKey('record') ? { record: optionalKey('record') } : {}), ...(raw.expect ? { expect: raw.expect as 'implementation-address' } : {}), ...(derivedCreate ? { derivedCreate } : {}), ...(optionalKey('expectCodeOf') ? { expectCodeOf: optionalKey('expectCodeOf') } : {}), ...(optionalKey('verifyAs') ? { verifyAs: optionalKey('verifyAs') } : {}), ...(constructorArgs ? { constructorArgs } : {}), ...(assertCalls ? { assertCalls } : {}) };
  }
  private parseArtifact(raw: unknown): ParsedContractArtifact {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !['abi', 'creationBytecode', 'runtimeBytecode', 'solcVersion', 'standardJsonInput', 'sourceIdentifier'].includes(key))) this.failed('getContractArtifact returned an invalid result');
    if (!Array.isArray(raw.abi) || (jsonBytes(raw.abi) ?? Infinity) > 512 * 1024 || typeof raw.creationBytecode !== 'string' || !HEX.test(raw.creationBytecode) || raw.creationBytecode === '0x' || (raw.creationBytecode.length - 2) / 2 > 1024 * 1024 || typeof raw.runtimeBytecode !== 'string' || !HEX.test(raw.runtimeBytecode) || raw.runtimeBytecode === '0x' || (raw.runtimeBytecode.length - 2) / 2 > 1024 * 1024) this.failed('getContractArtifact returned invalid bytecode');
    const solcVersion = text(raw.solcVersion, 64); const sourceIdentifier = text(raw.sourceIdentifier, 512);
    const [sourcePath, contractName, ...extra] = (sourceIdentifier ?? '').split(':');
    if (!solcVersion || !sourceIdentifier || !SOURCE_PATH.test(sourcePath) || !contractName || extra.length > 0) this.failed('getContractArtifact returned invalid metadata');
    this.validateStandardJson(raw.standardJsonInput);
    if (!isRecord(raw.standardJsonInput) || !isRecord(raw.standardJsonInput.sources) || !isRecord(raw.standardJsonInput.sources[sourcePath])) this.failed('getContractArtifact bundle does not contain the artifact source');
    return { abi: raw.abi, creationBytecode: raw.creationBytecode as `0x${string}`, runtimeBytecode: raw.runtimeBytecode as `0x${string}`, solcVersion, standardJsonInput: raw.standardJsonInput, sourceIdentifier };
  }
  private validateStandardJson(raw: unknown): void {
    if (!isRecord(raw) || raw.language !== 'Solidity' || !isRecord(raw.sources) || !isRecord(raw.settings) || (jsonBytes(raw) ?? Infinity) > 10 * 1024 * 1024) this.failed('getContractArtifact returned an invalid standard JSON input');
    const sources = Object.entries(raw.sources);
    if (sources.length === 0 || sources.length > 512) this.failed('getContractArtifact returned an invalid standard JSON input');
    for (const [path, source] of sources) if (!SOURCE_PATH.test(path) || !isRecord(source) || typeof source.content !== 'string' || 'urls' in source) this.failed('getContractArtifact returned an invalid standard JSON input');
  }
  private validateDescriptor(descriptor: ContractTypeInfo, artifacts: Record<string, ParsedContractArtifact>): void {
    const artifactKeys = new Set(descriptor.artifacts); const params = new Map(descriptor.params.map((param) => [param.key, param]));
    for (const key of descriptor.artifacts) this.validateAbiShape(artifacts[key]);
    if (descriptor.synthesis) {
      if (!artifactKeys.has(descriptor.synthesis.artifact)) this.failed('synthesis references an unknown artifact');
      const constructor = this.constructorInputs(artifacts[descriptor.synthesis.artifact]);
      if (constructor.length !== descriptor.synthesis.constructorArgs.length) this.failed('synthesis constructor arguments do not match artifact ABI');
      for (const arg of descriptor.synthesis.constructorArgs) {
        const input = constructor.find((item) => item.name === arg.name);
        if (!input) this.failed('synthesis constructor argument does not match artifact ABI');
        if (arg.from === 'implementation' && input.type !== 'address') this.failed('implementation synthesis argument must target an address input');
        if (arg.from === 'initializer' && input.type !== 'bytes') this.failed('initializer synthesis argument must target a bytes input');
        if (arg.from === 'param') { const param = params.get(arg.param); if (!param || !matchesParamType(param.type, input.type)) this.failed('parameter synthesis argument does not match artifact ABI'); }
      }
    }
    const recorded = new Set(descriptor.capture.flatMap((capture) => capture.record ? [capture.record] : []));
    for (const capture of descriptor.capture) {
      for (const artifact of [capture.record, capture.expectCodeOf, capture.verifyAs]) if (artifact !== undefined && !artifactKeys.has(artifact)) this.failed('capture references an unknown artifact');
      // verifyAs/assertCalls act on a captured ADDRESS, so the referenced key
      // must actually be recorded by some capture, not merely exist as an
      // artifact — otherwise the failure only shows up after deployment.
      if (capture.verifyAs !== undefined && !recorded.has(capture.verifyAs)) this.failed('capture verifyAs must reference a recorded capture');
      const verifyArtifact = capture.verifyAs === undefined ? undefined : artifacts[capture.verifyAs];
      const verifyInputs = verifyArtifact === undefined ? undefined : this.constructorInputs(verifyArtifact);
      const constructorArgs = capture.constructorArgs ?? [];
      if (verifyInputs && constructorArgs.length !== verifyInputs.length) this.failed('capture constructorArgs do not match the verifyAs constructor ABI');
      constructorArgs.forEach((parameter, index) => {
        const param = params.get(parameter);
        if (!param) this.failed('capture references an unknown parameter');
        if (verifyInputs && !matchesParamType(param!.type, verifyInputs[index]!.type)) this.failed('capture constructorArgs do not match the verifyAs constructor ABI');
      });
      for (const assertion of capture.assertCalls ?? []) {
        if (!recorded.has(assertion.on) || !params.has(assertion.expectParam)) this.failed('capture assertion references an unrecorded artifact or unknown parameter');
        const fn = this.zeroArgFunction(artifacts[assertion.on], assertion.call);
        if (!fn) this.failed('capture assertion function is not a zero-argument function of the target artifact');
        if (!matchesParamType(params.get(assertion.expectParam)!.type, fn!.outputs[0]?.type ?? '')) this.failed('capture assertion return type does not match the expected parameter');
      }
    }
  }
  private validateAbiShape(artifact: ParsedContractArtifact | undefined): void {
    if (!artifact) this.failed('descriptor references a missing artifact');
    for (const entry of artifact!.abi as unknown[]) {
      if (!isRecord(entry) || typeof entry.type !== 'string') this.failed('artifact ABI entry is invalid');
      if (entry.type !== 'function' && entry.type !== 'constructor') continue;
      for (const side of ['inputs', 'outputs'] as const) {
        if (entry[side] === undefined) continue;
        if (!Array.isArray(entry[side])) this.failed('artifact ABI entry is invalid');
        for (const parameter of entry[side] as unknown[]) this.validateAbiParameter(parameter);
      }
    }
  }
  private validateAbiParameter(parameter: unknown): void {
    if (!isRecord(parameter) || typeof parameter.type !== 'string') this.failed('artifact ABI parameter is invalid');
    const record = parameter as Record<string, unknown>;
    const type = record.type as string;
    if (/^tuple(\[\d*\])*$/.test(type)) {
      if (!Array.isArray(record.components)) this.failed('artifact ABI parameter is invalid');
      for (const component of record.components as unknown[]) this.validateAbiParameter(component);
      return;
    }
    // Leaf types must be real ABI types so later viem encode/decode calls
    // cannot be crashed by hostile strings like uint7.
    try { parseAbiParameters(type); } catch { this.failed('artifact ABI parameter is invalid'); }
  }
  private zeroArgFunction(artifact: ParsedContractArtifact | undefined, call: string): { outputs: Array<{ type: string }> } | undefined {
    if (!artifact) return undefined;
    const entry = (artifact.abi as unknown[]).find((item) => {
      if (!isRecord(item) || item.type !== 'function') return false;
      try { return toFunctionSignature(item as never) === call; } catch { return false; }
    }) as Record<string, unknown> | undefined;
    if (!entry || (Array.isArray(entry.inputs) && entry.inputs.length > 0) || !Array.isArray(entry.outputs) || entry.outputs.length !== 1) return undefined;
    return entry as never;
  }
  private constructorInputs(artifact: ParsedContractArtifact): Array<{ name: string; type: string }> {
    const entry = (artifact.abi as unknown[]).find((item) => isRecord(item) && item.type === 'constructor') as Record<string, unknown> | undefined;
    if (!entry || !Array.isArray(entry.inputs)) this.failed('artifact ABI has no constructor');
    const inputs = entry.inputs.map((input: unknown) => isRecord(input) && typeof input.name === 'string' && typeof input.type === 'string' ? { name: input.name, type: input.type } : undefined);
    if (inputs.some((input) => !input)) this.failed('artifact constructor ABI is invalid');
    return inputs as Array<{ name: string; type: string }>;
  }
  private parseFunctions(raw: unknown, cap: number): string[] { if (!Array.isArray(raw) || raw.length > cap) this.failed('describeContractType returned invalid function signatures'); return raw.map((item) => this.parseFunction(item)); }
  private parseFunction(raw: unknown): string { if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) this.failed('describeContractType returned invalid function signature'); try { const item = parseAbiItem(`function ${raw}`); const signature = toFunctionSignature(item as never); if (signature !== raw) this.failed('describeContractType function signatures must be canonical'); return signature; } catch { this.failed('describeContractType returned invalid function signature'); } }
  private key(raw: unknown, label: string): string { if (typeof raw !== 'string' || !KEY.test(raw) || raw.length > 64) this.failed(`describeContractType returned an invalid ${label} key`); return raw; }
  private keys(raw: unknown, cap: number, label: string): string[] { if (!Array.isArray(raw) || raw.length > cap) this.failed(`describeContractType returned invalid ${label}s`); return raw.map((entry) => this.key(entry, label)); }
  private failed(message: string): never { throw new IgniteError(message, 'CONTRACT_TYPE_OP_FAILED'); }
}

function omitPluginId(info: ContractTypeInfo): NormalizedContractTypeDescriptor { const { pluginId: _pluginId, ...descriptor } = info; return descriptor; }
function matchesParamType(type: NormalizedContractTypeDescriptor['params'][number]['type'], abiType: string): boolean {
  if (type === 'address') return abiType === 'address'; if (type === 'boolean') return abiType === 'bool'; if (type === 'string') return abiType === 'string'; if (type === 'number') return /^u?int\d*$/.test(abiType); return type === 'select' && abiType === 'string';
}
