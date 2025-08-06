// MVP Foundry Detection Plugin
import { promises as fs } from "fs";
import { join } from "path";
import {
  CompilerPlugin,
  PluginType,
  type DetectOptions,
  type DetectionResult,
  type PluginResult,
} from "../../shared/index.ts";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class FoundryPlugin extends CompilerPlugin {
  constructor() {
    super({
      id: "foundry",
      type: PluginType.COMPILER,
      name: "Foundry Compiler",
      version: PLUGIN_VERSION,
      baseImage: "ignite/compiler_foundry:latest",
    });
  }

  async detect(options: DetectOptions): Promise<PluginResult<DetectionResult>> {
    try {
      const workspacePath = options.workspacePath || "/workspace";
      const foundryTomlPath = join(workspacePath, "foundry.toml");
      await fs.access(foundryTomlPath);

      return {
        success: true,
        data: {
          detected: true,
        },
      };
    } catch {
      return {
        success: true,
        data: {
          detected: false,
        },
      };
    }
  }
}

export const plugin = new FoundryPlugin();

// CLI entrypoint - always run when container starts
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || "/workspace";

async function main() {
  const result = await plugin.detect({
    repoContainerName: "ignite-repo-local-default-workspace",
    workspacePath: WORKSPACE_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
