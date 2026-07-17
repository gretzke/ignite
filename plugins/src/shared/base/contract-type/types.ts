import { PluginType } from '../../types.js';
import type { PluginResponse } from '../../types.js';
import type { NoParams } from '../../index.js';

// Deliberately mirrors deployment-type fields, with address added because
// contract types need pointer-capable owner/implementation parameters.
export interface ContractTypeParam {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'address';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  description?: string;
}

export type SynthesisArg =
  | { name: string; from: 'implementation' }
  | { name: string; from: 'param'; param: string }
  | { name: string; from: 'initializer' };

export interface CaptureSpec {
  slot: `0x${string}`;
  record?: string;
  expect?: 'implementation-address';
  derivedCreate?: { nonce: number };
  expectCodeOf?: string;
  verifyAs?: string;
  constructorArgs?: string[];
  assertCalls?: Array<{ call: string; on: string; expectParam: string }>;
}

export interface DescribeContractTypeResult {
  label: string;
  description: string;
  versionLabel: string;
  params: ContractTypeParam[];
  artifacts: string[];
  synthesis: { artifact: string; constructorArgs: SynthesisArg[] } | null;
  validation: {
    requiredFunctions?: string[];
    probe?: { call: string; expectReturn: `0x${string}` };
    warnings?: Array<{
      when: 'impl-has-function';
      fn: string;
      message: string;
    }>;
  };
  capture: CaptureSpec[];
}

export interface GetContractArtifactParams {
  artifactKey: string;
}

export interface GetContractArtifactResult {
  abi: unknown;
  creationBytecode: `0x${string}`;
  runtimeBytecode: `0x${string}`;
  solcVersion: string;
  standardJsonInput: unknown;
  sourceIdentifier: string;
}

export type ContractTypeOperations = {
  describeContractType: { params: NoParams; result: DescribeContractTypeResult };
  getContractArtifact: { params: GetContractArtifactParams; result: GetContractArtifactResult };
};
export type ContractTypeOperation = keyof ContractTypeOperations;

export type IContractTypePlugin = {
  type: PluginType.CONTRACT_TYPE;
} & {
  [K in keyof ContractTypeOperations]: (
    options: ContractTypeOperations[K]['params'],
  ) => Promise<PluginResponse<ContractTypeOperations[K]['result']>>;
};
