// Base class for compiler plugins (Foundry, Hardhat, etc.)
import { BasePlugin } from "../../base-plugin.js";
import { PluginType } from "../../types.js";
import type {
  ICompilerPlugin,
  DetectionResult,
  ArtifactListResult,
  GetArtifactDataOptions,
  ArtifactData,
  GetVerificationBundleOptions,
  LinkReferences,
  VerificationBundleData,
  WatchPathsResult,
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
  abstract getArtifactData(
    options: GetArtifactDataOptions,
  ): Promise<PluginResponse<ArtifactData>>;
  abstract getVerificationBundle(
    options: GetVerificationBundleOptions,
  ): Promise<PluginResponse<VerificationBundleData>>;
  abstract getWatchPaths(): Promise<PluginResponse<WatchPathsResult>>;
}

// Re-export types for convenience
export type {
  CompilerOperations,
  CompilerOperation,
  DetectionResult,
  ArtifactListResult,
  ArtifactLocation,
  ICompilerPlugin,
  ArtifactData,
  GetArtifactDataOptions,
  GetVerificationBundleOptions,
  LinkReferences,
  VerificationBundleData,
  WatchPathsResult,
} from "./types.js";
