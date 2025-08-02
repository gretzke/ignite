// Local Repository Manager Plugin
import { RepoManagerPlugin } from "../../shared/index.ts";
import type { PluginResult } from "../../shared/index.ts";

export class LocalRepoPlugin extends RepoManagerPlugin {
  constructor() {
    super("local-repo");
  }

  getInfo() {
    return { name: "Local Repository Manager", version: "1.0.0" };
  }

  async mount(hostPath: string): Promise<PluginResult<{ mounted: boolean }>> {
    try {
      // The actual mounting is handled by the CLI orchestrator
      // This container just needs to keep the volume alive
      console.log(`🏠 Local repo mounted from: ${hostPath}`);

      return {
        success: true,
        data: { mounted: true },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to mount local repo: ${error}`,
      };
    }
  }
}

export const plugin = new LocalRepoPlugin();

// CLI entrypoint - keep container alive to maintain volume
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || "/workspace";

async function main() {
  console.log(`📁 Local repo container ready at: ${WORKSPACE_PATH}`);

  // Keep container alive - this maintains the volume mount
  process.on("SIGTERM", () => {
    console.log("📁 Local repo container shutting down");
    process.exit(0);
  });

  // Keep process alive
  setInterval(() => {
    // Heartbeat to keep container running
  }, 30000);
}

main().catch(console.error);
