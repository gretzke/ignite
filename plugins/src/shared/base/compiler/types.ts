import { PluginType } from "../../types.js";
import type { PluginResponse } from "../../types.js";
import type { NoParams } from "../../index.js";

export type CompilerOperations = {
  detect: {
    params: NoParams;
    result: DetectionResult;
  };
  // TODO: Add when needed
  // compile: {
  //   params: CompileOptions;
  //   result: CompileResult;
  // };
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
