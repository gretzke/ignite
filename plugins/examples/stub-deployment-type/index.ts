// Throwaway deployment-type plugin used only to verify the installed plugin
// path in plan-engine integration tests. Not shipped in the builtin catalog.
import {
  DeploymentTypePlugin,
  PluginType,
  runPluginCLI,
  type DeploymentTypeOperations,
  type DescribeDeploymentTypeResult,
  type PluginMetadata,
  type PluginResponse,
  type PrepareDeploymentParams,
  type PrepareDeploymentResult,
  type ValidateDeploymentParams,
  type ValidateDeploymentResult,
} from '../../src/shared/index.ts';
import { keccak256 } from 'viem';

declare const PLUGIN_VERSION: string;

const DEFAULT_TARGET_BYTE = 'c0';

function targetByte(params: Record<string, unknown> | undefined): string {
  const value = params?.targetByte;
  if (value === undefined || value === '') return DEFAULT_TARGET_BYTE;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{2}$/.test(value)) {
    throw new Error('targetByte must be exactly two hexadecimal characters');
  }
  return value.toLowerCase();
}

function saltFor(counter: bigint): `0x${string}` {
  return `0x${counter.toString(16).padStart(64, '0')}`;
}

function predictedAddress(
  proxyAddress: `0x${string}`,
  salt: `0x${string}`,
  initcodeHash: `0x${string}`
): `0x${string}` {
  return `0x${keccak256(`0xff${proxyAddress.slice(2)}${salt.slice(2)}${initcodeHash.slice(2)}`).slice(-40)}`;
}

const failed = <T>(code: string, message: string): PluginResponse<T> => ({
  success: false,
  error: { code, message },
});

export class StubDeploymentTypePlugin extends DeploymentTypePlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: 'stub-deployment-type',
      types: [PluginType.DEPLOYMENT_TYPE],
      name: 'Stub Deployment Type',
      version: typeof PLUGIN_VERSION === 'string' ? PLUGIN_VERSION : '0.0.1',
      baseImage: 'ignite/installed_stub-deployment-type:0.0.1',
      permissions: [],
      operations: [
        'describeDeploymentType',
        'prepareDeployment',
        'validateDeployment',
      ],
      configFields: [],
    };
  }

  async describeDeploymentType(): Promise<
    PluginResponse<DescribeDeploymentTypeResult>
  > {
    return {
      success: true,
      data: {
        label: 'Stub Deployment Type',
        description:
          'Mines a CREATE2 salt whose predicted address has a chosen low byte.',
        params: [
          {
            key: 'targetByte',
            label: 'Target address byte',
            type: 'string',
            required: false,
            description: 'Two hexadecimal characters; defaults to c0.',
          },
        ],
      },
    };
  }

  async prepareDeployment(
    options: PrepareDeploymentParams
  ): Promise<PluginResponse<PrepareDeploymentResult>> {
    try {
      const target = targetByte(options.params);
      const initcodeHash = keccak256(options.initcode as `0x${string}`);
      // Bounded so a regression fails fast with a typed error instead of
      // stranding the container until core's generic plugin timeout.
      for (let counter = 0n; counter < 1_000_000n; counter++) {
        const salt = saltFor(counter);
        const address = predictedAddress(
          options.proxyAddress as `0x${string}`,
          salt,
          initcodeHash
        );
        if (address.slice(-2).toLowerCase() === target) {
          return {
            success: true,
            // The core preparation route derives and persists initcodeHash
            // after independently checking this returned address/salt pair.
            data: {
              salt,
              predictedAddress: address,
              notes: [`mined low byte 0x${target}`],
            },
          };
        }
      }
      return failed('MINING_EXHAUSTED', 'Could not find a matching CREATE2 salt');
    } catch (error) {
      return failed(
        'INVALID_TARGET_BYTE',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async validateDeployment(
    options: ValidateDeploymentParams
  ): Promise<PluginResponse<ValidateDeploymentResult>> {
    try {
      const target = targetByte(options.params);
      const actual = options.predictedAddress.slice(-2).toLowerCase();
      return {
        success: true,
        data:
          actual === target
            ? { ok: true }
            : {
                ok: false,
                reason: `predicted address low byte 0x${actual} does not match 0x${target}`,
              },
      };
    } catch (error) {
      return failed(
        'INVALID_TARGET_BYTE',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

const plugin = new StubDeploymentTypePlugin();
export default plugin;

runPluginCLI<keyof DeploymentTypeOperations>(plugin);
