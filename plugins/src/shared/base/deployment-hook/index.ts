import { BasePlugin } from '../../base-plugin.js';
import { PluginType, type PluginResponse } from '../../types.js';
import type {
  DeploymentHookOperations,
  DescribeDeploymentHookResult,
  IDeploymentHookPlugin,
  OnRunCompletedParams,
  OnRunCompletedResult,
  SuggestAddressesParams,
  SuggestAddressesResult,
} from './types.js';

export abstract class DeploymentHookPlugin
  extends BasePlugin<PluginType.DEPLOYMENT_HOOK>
  implements IDeploymentHookPlugin
{
  public readonly type = PluginType.DEPLOYMENT_HOOK as const;

  abstract describeDeploymentHook(): Promise<PluginResponse<DescribeDeploymentHookResult>>;
  abstract onRunCompleted(options: OnRunCompletedParams): Promise<PluginResponse<OnRunCompletedResult>>;
  abstract suggestAddresses(options: SuggestAddressesParams): Promise<PluginResponse<SuggestAddressesResult>>;
}

export type {
  DeploymentHookAddressSuggestion,
  DeploymentHookOperations,
  DescribeDeploymentHookResult,
  IDeploymentHookPlugin,
  OnRunCompletedParams,
  OnRunCompletedResult,
  SuggestAddressesParams,
  SuggestAddressesResult,
} from './types.js';
