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

export interface ArtifactLocation {
  contractName: string;
  sourcePath: string; // relative to workspace root
  artifactPath: string; // relative to workspace root
}

export interface ArtifactListResult {
  artifacts: ArtifactLocation[];
}
