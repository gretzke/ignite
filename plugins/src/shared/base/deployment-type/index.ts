import { BasePlugin } from '../../base-plugin.js';
import { PluginType, type PluginResponse } from '../../types.js';
import type {
  DescribeDeploymentTypeResult,
  IDeploymentTypePlugin,
  PrepareDeploymentParams,
  PrepareDeploymentResult,
  ValidateDeploymentParams,
  ValidateDeploymentResult,
} from './types.js';

export abstract class DeploymentTypePlugin
  extends BasePlugin<PluginType.DEPLOYMENT_TYPE>
  implements IDeploymentTypePlugin
{
  public readonly type = PluginType.DEPLOYMENT_TYPE as const;

  abstract describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>>;
  abstract prepareDeployment(
    options: PrepareDeploymentParams,
  ): Promise<PluginResponse<PrepareDeploymentResult>>;
  abstract validateDeployment(
    options: ValidateDeploymentParams,
  ): Promise<PluginResponse<ValidateDeploymentResult>>;
}

export type {
  DeploymentTypeOperations,
  DeploymentTypeParamField,
  DescribeDeploymentTypeResult,
  IDeploymentTypePlugin,
  PrepareDeploymentParams,
  PrepareDeploymentResult,
  ValidateDeploymentParams,
  ValidateDeploymentResult,
} from './types.js';
