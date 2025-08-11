// Local Repository Manager Plugin
import {
  RepoManagerPlugin,
  PluginType,
  type PluginMetadata,
} from "../../shared/index.ts";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class LocalRepoPlugin extends RepoManagerPlugin {
  public readonly type = PluginType.REPO_MANAGER as const;

  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "local-repo",
      type: PluginType.REPO_MANAGER,
      name: "Local Repository Manager",
      version: PLUGIN_VERSION,
      baseImage: "ignite/base_repo-manager:latest",
    };
  }

  // No plugin-side operations - CLI handles all operations directly
  // This container just maintains the volume
}

const plugin = new LocalRepoPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || "/workspace";
console.log(`📁 Local repo container ready at: ${WORKSPACE_PATH}`);
