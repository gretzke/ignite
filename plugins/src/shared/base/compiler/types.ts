import { PluginResult, PluginType } from "../../types.js";

export type CompilerOperations = {
  detect: {
    params: DetectOptions;
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
  ) => Promise<PluginResult<CompilerOperations[K]["result"]>>;
};

export interface DetectOptions {
  workspacePath?: string;
}

export interface DetectionResult {
  detected: boolean;
}
