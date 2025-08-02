// MVP Foundry Detection Plugin
import { promises as fs } from "fs";
import { join } from "path";
import { CompilerPlugin } from "../../shared/index.ts";
import type { DetectionResult, PluginResult } from "../../shared/index.ts";

export class FoundryPlugin extends CompilerPlugin {
  constructor() {
    super("foundry");
  }

  getInfo() {
    return { name: "foundry", version: "1.0.0" };
  }

  async detect(workspacePath: string): Promise<PluginResult<DetectionResult>> {
    try {
      const foundryTomlPath = join(workspacePath, "foundry.toml");
      await fs.access(foundryTomlPath);
      return {
        success: true,
        data: true,
      };
    } catch {
      return {
        success: true,
        data: false,
      };
    }
  }
}

export const plugin = new FoundryPlugin();

// CLI entrypoint - always run when container starts
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || "/workspace";

async function main() {
  const result = await plugin.detect(WORKSPACE_PATH);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
