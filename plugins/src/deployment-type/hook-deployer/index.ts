import {
  DeploymentTypePlugin, PluginType, runPluginCLI,
  type PluginMetadata, type PluginResponse, type PrepareDeploymentParams,
  type PrepareDeploymentResult, type ValidateDeploymentParams,
  type ValidateDeploymentResult, type DescribeDeploymentTypeResult,
  type DeploymentTypeOperations,
} from '../../shared/index.ts';
import { keccak256 } from 'viem';
import { deriveFlags } from './evm.js';
import { mine, toBytes } from './mining.js';
declare const PLUGIN_VERSION: string;
const MASK = 0x3fff;
const parseFlags = (value: unknown): number => {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) throw new Error('flagsOverride must be a 14-bit hex or decimal mask');
  const flags = Number(BigInt(value)); if (!Number.isSafeInteger(flags) || flags < 0 || flags > MASK) throw new Error('flagsOverride exceeds 0x3FFF'); return flags;
};
const failed = <T>(code: string, message: string): PluginResponse<T> => ({ success: false, error: { code, message } });
export class HookDeployerPlugin extends DeploymentTypePlugin {
  protected static getMetadata(): PluginMetadata { return { id: 'hook-deployer', types: [PluginType.DEPLOYMENT_TYPE], name: 'v4 Hook Deployer', version: PLUGIN_VERSION, baseImage: 'ignite/deployment-type_hook-deployer:latest', permissions: [], operations: ['describeDeploymentType', 'prepareDeployment', 'validateDeployment'], configFields: [] }; }
  async describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>> { return { success: true, data: { label: 'v4 Hook Deployer', description: 'Mines a CREATE2 salt whose address encodes Uniswap v4 hook permissions.', params: [{ key: 'flagsOverride', label: 'Permission flags override', type: 'string', required: false, description: '14-bit hook permission mask (hex or decimal). Leave empty to derive from bytecode.' }] } }; }
  async prepareDeployment(options: PrepareDeploymentParams): Promise<PluginResponse<PrepareDeploymentResult>> {
    try {
      const initcode = toBytes(options.initcode as `0x${string}`); const override = options.params?.flagsOverride;
      const flags = override === undefined || override === '' ? await deriveFlags(initcode) : parseFlags(override);
      const found = mine(toBytes(keccak256(options.initcode as `0x${string}`)), toBytes(options.proxyAddress as `0x${string}`), flags);
      if (!found) return failed('MINING_CAP_EXCEEDED', 'Could not find a matching hook salt within the mining cap');
      return { success: true, data: { ...found, notes: [`flags: 0x${flags.toString(16).padStart(4, '0')}`, override === undefined || override === '' ? 'flags derived from bytecode' : 'flags overridden'] } };
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return failed(message.includes('flagsOverride') ? 'INVALID_FLAGS' : 'FLAG_DERIVATION_FAILED', message); }
  }
  async validateDeployment(options: ValidateDeploymentParams): Promise<PluginResponse<ValidateDeploymentResult>> {
    try { const override = options.params?.flagsOverride; const flags = override === undefined || override === '' ? await deriveFlags(toBytes(options.initcode as `0x${string}`)) : parseFlags(override); const actual = Number(BigInt(options.predictedAddress) & BigInt(MASK)); return { success: true, data: actual === flags ? { ok: true } : { ok: false, reason: `hook address flags 0x${actual.toString(16).padStart(4, '0')} do not match required 0x${flags.toString(16).padStart(4, '0')}` } }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return failed(message.includes('flagsOverride') ? 'INVALID_FLAGS' : 'FLAG_DERIVATION_FAILED', message); }
  }
}
const plugin = new HookDeployerPlugin(); export default plugin; runPluginCLI<keyof DeploymentTypeOperations>(plugin);
