import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type { NoParams, NoResult } from "../../index.js";

export type CompilerOperations = {
  detect: {
    params: NoParams;
    result: DetectionResult;
  };
  install: {
    params: NoParams;
    result: NoResult;
  };
  compile: {
    params: NoParams;
    result: NoResult;
  };
  listArtifacts: {
    params: NoParams;
    result: ArtifactListResult;
  };
  getArtifactData: {
    params: GetArtifactDataOptions;
    result: ArtifactData;
  };
  getVerificationBundle: {
    params: GetVerificationBundleOptions;
    result: VerificationBundleData;
  };
  getWatchPaths: {
    params: NoParams;
    result: WatchPathsResult;
  };
};

// Extract valid operation names
export type CompilerOperation = keyof CompilerOperations;

// Automatically generate the interface from operations
export type ICompilerPlugin = {
  type: PluginType.COMPILER;
} & {
  [K in keyof CompilerOperations]: (
    options: CompilerOperations[K]["params"],
  ) => Promise<PluginResponse<CompilerOperations[K]["result"]>>;
};

export interface DetectionResult {
  detected: boolean;
}

// Workspace-relative locations whose changes should invalidate this
// framework's build. Core stat-fingerprints these on the HOST (no container)
// to decide when an incremental recompile is needed. The plugin must resolve
// them from its own config — source/artifact dirs are user-configurable
// (foundry.toml src/out, hardhat paths), so core cannot hardcode them.
export interface WatchPathsResult {
  config: string[]; // e.g. ["foundry.toml", "remappings.txt"]
  sources: string[]; // e.g. ["src", "test", "script", "lib"]
  artifacts: string[]; // e.g. ["out"]
}

export interface ArtifactLocation {
  contractName: string;
  sourcePath: string; // relative to workspace root
  artifactPath: string; // relative to workspace root
  variant?: {
    solcVersion?: string;
    profile?: string;
  };
}

export interface ArtifactListResult {
  artifacts: ArtifactLocation[];
}

export interface LinkReference {
  start: number;
  length: number;
}

export interface LinkReferences {
  [path: string]: {
    [contractName: string]: LinkReference[];
  };
}

export interface GetArtifactDataOptions {
  artifactPath: string; // relative to workspace root
}

export interface GetVerificationBundleOptions {
  artifactPath: string; // relative to workspace root
}

export interface ArtifactData {
  solidityVersion: string;
  optimizer: boolean;
  optimizerRuns: number;
  evmVersion?: string; // Optional - available in Foundry but not Hardhat
  viaIR: boolean;
  bytecodeHash: string;
  abi: any[]; // JSON ABI array
  creationCode: string;
  deployedBytecode: string;
  creationCodeLinkReferences?: LinkReferences;
  deployedBytecodeLinkReferences?: LinkReferences;
}

export interface VerificationBundleData {
  standardJsonInput: unknown;
  solcVersion: string;
  contractIdentifier: string;
  creationCode: string;
}
