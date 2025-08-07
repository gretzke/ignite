// MVP Foundry Detection Plugin
import { promises as fs } from "fs";
import { join } from "path";
import {
  CompilerPlugin,
  PluginType,
  type PluginMetadata,
  type DetectOptions,
  type DetectionResult,
  type PluginResult,
} from "../../shared/index.ts";
import { runPluginCLI } from "../../shared/plugin-runner.js";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class FoundryPlugin extends CompilerPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "foundry",
      type: PluginType.COMPILER,
      name: "Foundry Compiler",
      version: PLUGIN_VERSION,
      baseImage: "ignite/compiler_foundry:latest",
    };
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

const plugin = new FoundryPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
// Always run CLI when args are provided (for container execution)
if (process.argv.length > 1) {
  runPluginCLI(plugin);
}
