// Base class for compiler plugins (Foundry, Hardhat, etc.)
import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type {
  ICompilerPlugin,
  DetectOptions,
  DetectionResult,
} from "./types.js";
import type { PluginResponse } from "../../types.js";

export abstract class CompilerPlugin
  extends BasePlugin<PluginType.COMPILER>
  implements ICompilerPlugin
{
  public readonly type = PluginType.COMPILER as const;

  abstract detect(
    options: DetectOptions,
  ): Promise<PluginResponse<DetectionResult>>;
  // TODO: Add compile() and getArtifacts() when needed
}

// Re-export types for convenience
export type {
  CompilerOperations,
  CompilerOperation,
  ICompilerPlugin,
  DetectOptions,
  DetectionResult,
} from "./types.js";
