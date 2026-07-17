import { BasePlugin } from '../../base-plugin.js';
import { PluginType, type PluginResponse } from '../../types.js';
import type {
  DescribeContractTypeResult,
  GetContractArtifactParams,
  GetContractArtifactResult,
  IContractTypePlugin,
} from './types.js';

export abstract class ContractTypePlugin
  extends BasePlugin<PluginType.CONTRACT_TYPE>
  implements IContractTypePlugin
{
  public readonly type = PluginType.CONTRACT_TYPE as const;

  abstract describeContractType(): Promise<PluginResponse<DescribeContractTypeResult>>;
  abstract getContractArtifact(
    options: GetContractArtifactParams,
  ): Promise<PluginResponse<GetContractArtifactResult>>;
}

export type {
  CaptureSpec,
  ContractTypeOperation,
  ContractTypeOperations,
  ContractTypeParam,
  DescribeContractTypeResult,
  GetContractArtifactParams,
  GetContractArtifactResult,
  IContractTypePlugin,
  SynthesisArg,
} from './types.js';
