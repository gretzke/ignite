// Compiler plugin operation types
// Uses plugin operation result types directly from @ignite/plugin-types

export type {
  DetectionResult,
  ArtifactListResult,
  ArtifactLocation,
  ArtifactData,
  GetArtifactDataOptions,
} from "@ignite/plugin-types/base/compiler";

export interface GetArtifactDataRequest {
  pathOrUrl: string;
  pluginId: string;
  artifactPath: string;
}
