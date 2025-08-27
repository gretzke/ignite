// Hardhat Compiler Plugin
import { promises as fs } from "fs";
import { join } from "path";
import {
  CompilerPlugin,
  PluginType,
  type PluginMetadata,
  type DetectionResult,
  type PluginResponse,
  type CompilerOperation,
} from "../../shared/index.ts";
import { runPluginCLI } from "../../shared/plugin-runner.ts";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

export class HardhatPlugin extends CompilerPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "hardhat",
      type: PluginType.COMPILER,
      name: "Hardhat",
      version: PLUGIN_VERSION,
      baseImage: "ignite/shared:latest",
    };
  }

  async detect(): Promise<PluginResponse<DetectionResult>> {
    try {
      const hardhatConfigJsPath = join("/workspace", "hardhat.config.js");
      const hardhatConfigTsPath = join("/workspace", "hardhat.config.ts");

      // Try to access either hardhat.config.js or hardhat.config.ts
      try {
        await fs.access(hardhatConfigJsPath);
        return {
          success: true,
          data: {
            detected: true,
          },
        };
      } catch {
        // Try TypeScript config if JS config doesn't exist
        await fs.access(hardhatConfigTsPath);
        return {
          success: true,
          data: {
            detected: true,
          },
        };
      }
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

const plugin = new HardhatPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
runPluginCLI<CompilerOperation>(plugin);
