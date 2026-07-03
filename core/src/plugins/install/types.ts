import type { PluginMetadata } from '@ignite/plugin-types/types';

// Discriminated so Spec B can add { kind: 'git'; url: string } without breaking
// the install contract. For a local build, contextDir is the Docker build
// context and dockerfile is the Dockerfile path relative to it (defaults to
// 'Dockerfile'). The stub fixture needs the monorepo's plugins/ dir as context,
// so contextDir and dockerfile are separate rather than a single folder path.
export type PluginInstallSource = {
  kind: 'local';
  contextDir: string;
  dockerfile?: string;
};

export interface PluginBuildResult {
  imageTag: string;
  metadata: PluginMetadata;
}

// The swappable seam: Spec A builds from a local folder on the host; Spec B
// swaps in an isolated builder. Everything downstream is backend-independent.
export interface PluginBuildBackend {
  buildPluginImage(source: PluginInstallSource): Promise<PluginBuildResult>;
}
