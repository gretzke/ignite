import { PluginType, type PluginResponse } from '../../types.js';
import type { NoParams } from '../../index.js';

export interface DescribeDeploymentHookResult {
  label: string;
  description: string;
}

export interface OnRunCompletedParams {
  artifact: unknown;
  workflowName: string;
}

export interface OnRunCompletedResult {
  notes?: string[];
}

export interface SuggestAddressesParams {
  chainIds: number[];
  contractName?: string;
}

export interface DeploymentHookAddressSuggestion {
  chainId: number;
  address: string;
  label?: string;
  contractName?: string;
  versionLabel?: string;
}

export interface SuggestAddressesResult {
  suggestions: DeploymentHookAddressSuggestion[];
}

export type DeploymentHookOperations = {
  describeDeploymentHook: { params: NoParams; result: DescribeDeploymentHookResult };
  onRunCompleted: { params: OnRunCompletedParams; result: OnRunCompletedResult };
  suggestAddresses: { params: SuggestAddressesParams; result: SuggestAddressesResult };
};

export type IDeploymentHookPlugin = {
  type: PluginType.DEPLOYMENT_HOOK;
} & {
  [K in keyof DeploymentHookOperations]: (
    options: DeploymentHookOperations[K]['params'],
  ) => Promise<PluginResponse<DeploymentHookOperations[K]['result']>>;
};
