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
  type NoResult,
  type ArtifactListResult,
  type ArtifactLocation,
  type GetArtifactDataOptions,
  type ArtifactData,
  type LinkReferences,
} from "../../shared/index.ts";
import { execCommand } from "../../shared/utils/exec.js";
import { runPluginCLI } from "../../shared/plugin-runner.ts";
import {
  traverseDirectory,
  jsonArtifactFilter,
  extractContractNameFromPath,
  fileExists,
  readJsonFile,
} from "../../shared/utils/artifacts.js";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

// Hardhat artifact structure
interface HardhatArtifact {
  _format: string;
  contractName: string;
  sourceName: string;
  abi: any[];
  bytecode: string;
  deployedBytecode?: string;
  linkReferences?: any;
  deployedLinkReferences?: any;
}

export class HardhatPlugin extends CompilerPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "hardhat",
      type: PluginType.COMPILER,
      name: "Hardhat",
      version: PLUGIN_VERSION,
      // use foundry base image for hardhat repos using the hardhat-foundry plugin
      baseImage: "ignite/compiler_foundry:latest",
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

  async install(): Promise<PluginResponse<NoResult>> {
    let result;
    try {
      // if yarn.lock exists, use yarn, otherwise use npm
      await fs.access(join("/workspace", "yarn.lock"));
      result = await execCommand("yarn", ["install"], "/workspace");
    } catch {
      result = await execCommand("npm", ["install"], "/workspace");
    }

    if (!result.success) {
      return {
        success: false,
        error: {
          code: "NPM_INSTALL_FAILED",
          message: "Failed to run npm install",
          details: result.error?.details,
        },
      };
    }

    return {
      success: true,
      data: {},
    };
  }

  async compile(): Promise<PluginResponse<NoResult>> {
    const result = await execCommand(
      "npx",
      ["hardhat", "compile"],
      "/workspace",
    );

    if (!result.success) {
      return {
        success: false,
        error: {
          code: "HARDHAT_COMPILE_FAILED",
          message: "Compilation failed",
          details: result.error?.details,
        },
      };
    }

    return {
      success: true,
      data: {},
    };
  }

  async listArtifacts(): Promise<PluginResponse<ArtifactListResult>> {
    try {
      const workspaceRoot = "/workspace";

      // Parse hardhat config to get the artifacts directory (default: "artifacts")
      const artifactsDir = await this.getHardhatDir(workspaceRoot, "artifacts");
      const artifactsPath = join(workspaceRoot, artifactsDir);

      // Check if artifacts directory exists
      if (!(await fileExists(artifactsPath))) {
        return {
          success: true,
          data: {
            artifacts: [],
          },
        };
      }

      // Traverse artifacts directory for JSON files
      const artifactFiles = await traverseDirectory(
        artifactsPath,
        jsonArtifactFilter,
        workspaceRoot,
      );

      const artifacts: ArtifactLocation[] = [];

      const sourceDir = await this.getHardhatDir(
        workspaceRoot,
        "sources",
        "contracts",
      );

      // Process each artifact file and read contents to check bytecode
      for (const file of artifactFiles) {
        const contractName = extractContractNameFromPath(file.path);

        // Skip debug files and other non-contract artifacts
        if (
          contractName.endsWith(".dbg") ||
          contractName === "build-info" ||
          file.relativePath.includes("/build-info/")
        ) {
          continue;
        }

        // Read and parse the artifact file
        const artifactData = await readJsonFile<HardhatArtifact>(file.path);
        if (!artifactData) {
          continue; // Skip if can't read or parse JSON
        }

        // Skip if bytecode is empty (0x means no deployable bytecode)
        if (!artifactData.bytecode || artifactData.bytecode === "0x") {
          continue;
        }

        // Use sourceName from artifact for accurate source path
        let sourcePath = artifactData.sourceName || "";
        if (!sourcePath.startsWith(sourceDir)) {
          sourcePath = join("node_modules", sourcePath);
        }

        // Validate and sanitize paths to prevent JSON corruption
        if (!contractName || !sourcePath || !file.relativePath) {
          continue; // Skip invalid entries
        }

        // Create artifact entry
        const artifact: ArtifactLocation = {
          contractName: contractName.trim(),
          sourcePath: sourcePath.trim(),
          artifactPath: file.relativePath.trim(),
        };

        artifacts.push(artifact);
      }

      return {
        success: true,
        data: {
          artifacts,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "ARTIFACT_LISTING_FAILED",
          message: `Failed to list artifacts: ${
            error instanceof Error ? error.message : String(error)
          }`,
          details: {
            stack: error instanceof Error ? error.stack : undefined,
          },
        },
      };
    }
  }

  async getArtifactData(
    options: GetArtifactDataOptions,
  ): Promise<PluginResponse<ArtifactData>> {
    try {
      const workspaceRoot = "/workspace";
      const artifactPath = join(workspaceRoot, options.artifactPath);

      // Check if artifact file exists
      if (!(await fileExists(artifactPath))) {
        return {
          success: false,
          error: {
            code: "ARTIFACT_NOT_FOUND",
            message: `Artifact file not found: ${options.artifactPath}`,
          },
        };
      }

      // Read and parse the artifact file
      const artifactData = await readJsonFile<HardhatArtifact>(artifactPath);
      if (!artifactData) {
        return {
          success: false,
          error: {
            code: "ARTIFACT_PARSE_ERROR",
            message: `Failed to parse artifact file: ${options.artifactPath}`,
          },
        };
      }

      // Try to read build-info file for compilation settings
      const buildInfo = await this.getBuildInfo(artifactData.sourceName);

      // Parse link references for both creation and deployed bytecode
      const creationCodeLinkReferences = this.parseLinkReferences(
        artifactData.linkReferences,
      );
      const deployedBytecodeLinkReferences = this.parseLinkReferences(
        artifactData.deployedLinkReferences,
      );

      const result: ArtifactData = {
        solidityVersion:
          buildInfo?.solcLongVersion || buildInfo?.solcVersion || "unknown",
        optimizer: buildInfo?.optimizer || false,
        optimizerRuns: buildInfo?.optimizerRuns || 0,
        // evmVersion not available in Hardhat artifacts - left undefined
        viaIR: buildInfo?.viaIR || false,
        bytecodeHash: buildInfo?.bytecodeHash || "ipfs",
        abi: artifactData.abi || [],
        creationCode: artifactData.bytecode || "0x",
        deployedBytecode: artifactData.deployedBytecode || "0x",
        ...(creationCodeLinkReferences && {
          creationCodeLinkReferences,
        }),
        ...(deployedBytecodeLinkReferences && {
          deployedBytecodeLinkReferences,
        }),
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "ARTIFACT_DATA_EXTRACTION_FAILED",
          message: `Failed to extract artifact data: ${
            error instanceof Error ? error.message : String(error)
          }`,
          details: {
            stack: error instanceof Error ? error.stack : undefined,
          },
        },
      };
    }
  }

  // Helper method to parse Hardhat link references into our standard format
  private parseLinkReferences(linkRefs: any): LinkReferences | undefined {
    if (!linkRefs || typeof linkRefs !== "object") {
      return undefined;
    }

    const result: LinkReferences = {};

    // Hardhat link references structure: { "path/file.sol": { "ContractName": [{ start: number, length: number }] } }
    for (const [filePath, contracts] of Object.entries(linkRefs)) {
      if (typeof contracts === "object" && contracts !== null) {
        result[filePath] = {};
        for (const [contractName, positions] of Object.entries(contracts)) {
          if (Array.isArray(positions)) {
            result[filePath][contractName] = positions.map((pos: any) => ({
              start: pos.start || 0,
              length: pos.length || 0,
            }));
          }
        }
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  // Try to extract compilation settings from build-info files
  private async getBuildInfo(sourceName: string): Promise<{
    solcVersion?: string;
    solcLongVersion?: string;
    optimizer?: boolean;
    optimizerRuns?: number;
    viaIR?: boolean;
    bytecodeHash?: string;
  } | null> {
    try {
      // Build-info files are typically in artifacts/build-info/
      const artifactsDir = await this.getHardhatDir("/workspace", "artifacts");
      const buildInfoDir = join("/workspace", artifactsDir, "build-info");

      if (!(await fileExists(buildInfoDir))) {
        return null;
      }

      // Get all build-info files
      const buildInfoFiles = await fs.readdir(buildInfoDir);
      const jsonFiles = buildInfoFiles.filter((f) => f.endsWith(".json"));

      // Try to find a build-info file that contains our specific source file
      for (const file of jsonFiles) {
        const buildInfoPath = join(buildInfoDir, file);
        const buildInfo = await readJsonFile<any>(buildInfoPath);

        if (!buildInfo) continue;

        // Check if this build-info contains our source file
        const sources = buildInfo.input?.sources;
        if (sources && sources[sourceName]) {
          // Extract compiler settings
          const settings = buildInfo.input?.settings;

          if (settings) {
            return {
              solcVersion: buildInfo.solcVersion,
              solcLongVersion: buildInfo.solcLongVersion,
              optimizer: settings.optimizer?.enabled || false,
              optimizerRuns: settings.optimizer?.runs || 0,
              viaIR: settings.viaIR || false,
              bytecodeHash: settings.metadata?.bytecodeHash || "ipfs",
            };
          }
        }
      }

      return null;
    } catch (error) {
      // If we can't read build-info, return null and use defaults
      return null;
    }
  }

  // Parse hardhat.config.js/ts to get the artifacts directory
  // Returns "artifacts" as default if file doesn't exist or can't be parsed
  private async getHardhatDir(
    workspaceRoot: string,
    dir: string,
    defaultDir: string = dir,
  ): Promise<string> {
    // Try both .js and .ts config files
    const configFiles = ["hardhat.config.js", "hardhat.config.ts"];

    for (const configFile of configFiles) {
      const configPath = join(workspaceRoot, configFile);

      try {
        if (!(await fileExists(configPath))) {
          continue;
        }

        const configContent = await fs.readFile(configPath, "utf-8");

        // Parse the artifacts path from the config
        // Look for paths.artifacts = "..." or paths: { artifacts: "..." }
        const artifactsMatch = configContent.match(
          /paths\s*:\s*\{[^}]*${dir}\s*:\s*["']([^"']+)["']/,
        );

        if (artifactsMatch && artifactsMatch[1]) {
          // Remove leading ./ if present
          return artifactsMatch[1].replace(/^\.\//, "");
        }

        // Also check for direct assignment: paths.artifacts = "..."
        const directMatch = configContent.match(
          /paths\.artifacts\s*=\s*["']([^"']+)["']/,
        );
        if (directMatch && directMatch[1]) {
          return directMatch[1].replace(/^\.\//, "");
        }
      } catch (error) {
        // Continue to next config file or use default
        continue;
      }
    }

    return defaultDir; // Default if not found or error
  }
}

const plugin = new HardhatPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
runPluginCLI<CompilerOperation>(plugin);
