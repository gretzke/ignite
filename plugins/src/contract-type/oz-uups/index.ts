import {
  ContractTypePlugin,
  type ContractTypeOperation,
  PluginType,
  type DescribeContractTypeResult,
  type GetContractArtifactParams,
  type GetContractArtifactResult,
  type PluginMetadata,
  type PluginResponse,
} from '../../shared/index.ts';
import { runPluginCLI } from '../../shared/plugin-runner.js';
import erc1967Proxy from '../openzeppelin/artifacts/ERC1967Proxy.json' with { type: 'json' };

declare const PLUGIN_VERSION: string;

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const artifacts: Record<string, GetContractArtifactResult> = {
  proxy: erc1967Proxy as GetContractArtifactResult,
};

export class OzUupsContractTypePlugin extends ContractTypePlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: 'oz-uups',
      types: [PluginType.CONTRACT_TYPE],
      name: 'UUPS proxy (OZ 5.3.0)',
      version: PLUGIN_VERSION,
      baseImage: 'ignite/contract-type_oz-uups:latest',
      permissions: [{ id: 'contractBytecode', description: 'Supplies contract bytecode that your deployments will execute.' }],
      operations: ['describeContractType', 'getContractArtifact'],
    };
  }

  async describeContractType(): Promise<PluginResponse<DescribeContractTypeResult>> {
    return { success: true, data: {
      label: 'UUPS proxy',
      description: 'Deploy an OpenZeppelin ERC1967 UUPS proxy with constructor-time initialization.',
      versionLabel: 'OpenZeppelin Contracts 5.3.0',
      params: [],
      artifacts: ['proxy'],
      synthesis: { artifact: 'proxy', constructorArgs: [
        { name: 'implementation', from: 'implementation' },
        { name: '_data', from: 'initializer' },
      ] },
      validation: {
        requiredFunctions: ['proxiableUUID()', 'upgradeToAndCall(address,bytes)'],
        probe: { call: 'proxiableUUID()', expectReturn: IMPLEMENTATION_SLOT },
      },
      capture: [{ slot: IMPLEMENTATION_SLOT, expect: 'implementation-address' }],
    } };
  }

  async getContractArtifact(options: GetContractArtifactParams): Promise<PluginResponse<GetContractArtifactResult>> {
    const artifact = artifacts[options.artifactKey];
    return artifact
      ? { success: true, data: artifact }
      : { success: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `Unknown artifact '${options.artifactKey}'` } };
  }
}

const plugin = new OzUupsContractTypePlugin();
export default plugin;
runPluginCLI<ContractTypeOperation>(plugin);
