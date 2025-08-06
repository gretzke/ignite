// Local Repository Manager Plugin
import { RepoManagerPlugin, PluginType } from "../../shared/index.ts";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class LocalRepoPlugin extends RepoManagerPlugin {
  public readonly type = PluginType.REPO_MANAGER as const;

  constructor() {
    super({
      id: "local-repo",
      type: PluginType.REPO_MANAGER,
      name: "Local Repository Manager",
      version: PLUGIN_VERSION,
      baseImage: "ignite/base_repo-manager:latest",
    });
  }

  // No plugin-side operations - CLI handles all operations directly
  // This container just maintains the volume and stays alive
}

export const plugin = new LocalRepoPlugin();

// CLI entrypoint - keep container alive to maintain volume
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || "/workspace";

async function main() {
  console.log(`📁 Local repo container ready at: ${WORKSPACE_PATH}`);
}

main().catch(console.error);
