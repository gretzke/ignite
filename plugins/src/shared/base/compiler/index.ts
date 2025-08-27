// Base class for compiler plugins (Foundry, Hardhat, etc.)
import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type {
  ICompilerPlugin,
  DetectionResult,
  ArtifactListResult,
} from "./types.js";
import type { PluginResponse } from "../../types.js";
import type { NoResult } from "../../index.js";

export abstract class CompilerPlugin
  extends BasePlugin<PluginType.COMPILER>
  implements ICompilerPlugin
{
  public readonly type = PluginType.COMPILER as const;

  abstract detect(): Promise<PluginResponse<DetectionResult>>;
  abstract install(): Promise<PluginResponse<NoResult>>;
  abstract compile(): Promise<PluginResponse<NoResult>>;
  abstract listArtifacts(): Promise<PluginResponse<ArtifactListResult>>;
}

// Re-export types for convenience
export type {
  CompilerOperations,
  CompilerOperation,
  DetectionResult,
  ArtifactListResult,
  ArtifactLocation,
  ICompilerPlugin,
} from "./types.js";
