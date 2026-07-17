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
import transparentProxy from '../openzeppelin/artifacts/TransparentUpgradeableProxy.json' with { type: 'json' };
import proxyAdmin from '../openzeppelin/artifacts/ProxyAdmin.json' with { type: 'json' };

declare const PLUGIN_VERSION: string;

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const artifacts: Record<string, GetContractArtifactResult> = {
  proxy: transparentProxy as GetContractArtifactResult,
  admin: proxyAdmin as GetContractArtifactResult,
};

export class OzTransparentContractTypePlugin extends ContractTypePlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: 'oz-transparent',
      types: [PluginType.CONTRACT_TYPE],
      name: 'Transparent proxy (OZ 5.3.0)',
      version: PLUGIN_VERSION,
      baseImage: 'ignite/contract-type_oz-transparent:latest',
      permissions: [{ id: 'contractBytecode', description: 'Supplies contract bytecode that your deployments will execute.' }],
      operations: ['describeContractType', 'getContractArtifact'],
    };
  }

  async describeContractType(): Promise<PluginResponse<DescribeContractTypeResult>> {
    return { success: true, data: {
      label: 'Transparent proxy',
      description: 'Deploy an OpenZeppelin transparent upgradeable proxy with constructor-time initialization.',
      versionLabel: 'OpenZeppelin Contracts 5.3.0',
      params: [{ key: 'initialOwner', label: 'Initial owner', type: 'address', required: true }],
      artifacts: ['proxy', 'admin'],
      synthesis: { artifact: 'proxy', constructorArgs: [
        { name: '_logic', from: 'implementation' },
        { name: 'initialOwner', from: 'param', param: 'initialOwner' },
        { name: '_data', from: 'initializer' },
      ] },
      validation: { warnings: [{
        when: 'impl-has-function',
        fn: 'upgradeToAndCall(address,bytes)',
        message: 'The implementation exposes upgradeToAndCall(address,bytes), creating a transparent-proxy and UUPS dual upgrade path.',
      }] },
      capture: [
        { slot: IMPLEMENTATION_SLOT, expect: 'implementation-address' },
        { slot: ADMIN_SLOT, record: 'admin', derivedCreate: { nonce: 1 }, expectCodeOf: 'admin', verifyAs: 'admin', constructorArgs: ['initialOwner'], assertCalls: [{ call: 'owner()', on: 'admin', expectParam: 'initialOwner' }] },
      ],
    } };
  }

  async getContractArtifact(options: GetContractArtifactParams): Promise<PluginResponse<GetContractArtifactResult>> {
    const artifact = artifacts[options.artifactKey];
    return artifact
      ? { success: true, data: artifact }
      : { success: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `Unknown artifact '${options.artifactKey}'` } };
  }
}

const plugin = new OzTransparentContractTypePlugin();
export default plugin;
runPluginCLI<ContractTypeOperation>(plugin);
