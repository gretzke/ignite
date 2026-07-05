import type { PluginMetadata } from '@ignite/plugin-types/types';

// Where a self-contained installed-plugin image carries its bundle. Baked in
// by the build backends and invoked by both finalizeImage (getInfo probe) and
// PluginExecutionUtils (operation exec).
export const INSTALLED_PLUGIN_ENTRYPOINT = '/plugin/index.js';

// Discriminated union of install sources. Spec A: local folder (host build).
// Spec B: git URL (isolated build). Downstream (PluginInstaller, API, tab) is
// source-agnostic; only the build backends branch on `kind`.
export type PluginInstallSource =
  | { kind: 'local'; contextDir: string; dockerfile?: string }
  | { kind: 'git'; url: string; ref?: string };

export interface PluginBuildResult {
  imageTag: string;
  metadata: PluginMetadata;
}

// The swappable seam: Spec A builds from a local folder on the host; Spec B
// swaps in an isolated builder. Everything downstream is backend-independent.
export interface PluginBuildBackend {
  buildPluginImage(source: PluginInstallSource): Promise<PluginBuildResult>;
}
