import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type { NoParams } from "../../index.js";

export type VerifierOperations = {
  getSupportedExplorers: {
    params: NoParams;
    result: SupportedExplorersResult;
  };
  verify: { params: VerifyParams; result: VerifyStatusResult };
  checkVerification: {
    params: CheckVerificationParams;
    result: VerifyStatusResult;
  };
  getCreationTx: { params: GetCreationTxParams; result: CreationTxResult };
};

export type VerifierOperation = keyof VerifierOperations;

export type IVerifierPlugin = {
  type: PluginType.VERIFIER;
} & {
  [K in keyof VerifierOperations]: (
    options: VerifierOperations[K]["params"],
  ) => Promise<PluginResponse<VerifierOperations[K]["result"]>>;
};

export interface SupportedExplorersResult {
  explorers: DetectedExplorer[] | null;
  urlPatterns: string[];
}

export interface DetectedExplorer {
  chainId: number;
  explorerUrl: string;
  label?: string;
}

export interface VerifyParams {
  chainId: number;
  address: string;
  explorerUrl: string;
  apiUrl?: string;
  standardJsonInput: unknown;
  solcVersion: string;
  contractIdentifier: string;
  encodedConstructorArgs: string;
  creationTxHash?: string;
  compilerSummary: {
    pluginId: string;
    evmVersion?: string;
    optimizer: boolean;
    runs: number;
    viaIR: boolean;
  };
}

export interface CheckVerificationParams {
  pollTicket: string;
  chainId: number;
  address: string;
  explorerUrl: string;
  apiUrl?: string;
}

export interface GetCreationTxParams {
  chainId: number;
  address: string;
  explorerUrl: string;
  apiUrl?: string;
}

export type CreationTxResult = { txHash: string } | null;

export interface VerifyStatusResult {
  status: "verified" | "already-verified" | "pending" | "failed";
  pollTicket?: string;
  verifiedUrl?: string;
  detail?: string;
  retryable?: boolean;
}
