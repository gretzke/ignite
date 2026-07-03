import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from './types.js';

// Dispatches a build to the backend that handles the source kind. Keeps
// PluginInstaller fully source-agnostic (it holds one PluginBuildBackend).
export class RoutingBuildBackend implements PluginBuildBackend {
  constructor(
    private local: PluginBuildBackend,
    private git: PluginBuildBackend
  ) {}

  buildPluginImage(source: PluginInstallSource): Promise<PluginBuildResult> {
    switch (source.kind) {
      case 'local':
        return this.local.buildPluginImage(source);
      case 'git':
        return this.git.buildPluginImage(source);
      default: {
        const _exhaustive: never = source;
        return Promise.reject(
          new Error(`No build backend for source kind '${(_exhaustive as { kind: string }).kind}'`)
        );
      }
    }
  }
}
