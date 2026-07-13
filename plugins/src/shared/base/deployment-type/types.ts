import { PluginType } from '../../types.js';
import type { PluginResponse } from '../../types.js';
import type { NoParams } from '../../index.js';

// Deliberately mirrors the select option vocabulary of PluginConfigField.
export interface DeploymentTypeParamField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  description?: string;
}

export interface DescribeDeploymentTypeResult {
  label: string;
  description: string;
  params: DeploymentTypeParamField[];
}

export interface PrepareDeploymentParams {
  chainId: number;
  initcode: string;
  proxyAddress: string;
  params?: Record<string, unknown>;
}

export interface PrepareDeploymentResult {
  salt: string;
  predictedAddress: string;
  notes?: string[];
}

export interface ValidateDeploymentParams {
  chainId: number;
  initcode: string;
  salt: string;
  predictedAddress: string;
  params?: Record<string, unknown>;
}

export interface ValidateDeploymentResult {
  ok: boolean;
  reason?: string;
}

export type DeploymentTypeOperations = {
  describeDeploymentType: { params: NoParams; result: DescribeDeploymentTypeResult };
  prepareDeployment: { params: PrepareDeploymentParams; result: PrepareDeploymentResult };
  validateDeployment: { params: ValidateDeploymentParams; result: ValidateDeploymentResult };
};

export type IDeploymentTypePlugin = {
  type: PluginType.DEPLOYMENT_TYPE;
} & {
  [K in keyof DeploymentTypeOperations]: (
    options: DeploymentTypeOperations[K]['params'],
  ) => Promise<PluginResponse<DeploymentTypeOperations[K]['result']>>;
};
