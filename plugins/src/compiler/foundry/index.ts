// MVP Foundry Detection Plugin
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
import { runPluginCLI } from "../../shared/plugin-runner.js";
import {
  traverseDirectory,
  jsonArtifactFilter,
  fileExists,
  readJsonFile,
} from "../../shared/utils/artifacts.js";

// PLUGIN_VERSION is injected at build time via --define:PLUGIN_VERSION
declare const PLUGIN_VERSION: string;

// Foundry artifact structure
interface FoundryArtifact {
  abi: any[];
  bytecode: {
    object: string;
    opcodes?: string;
    sourceMap?: string;
    linkReferences?: any;
  };
  deployedBytecode?: {
    object: string;
    opcodes?: string;
    sourceMap?: string;
    linkReferences?: any;
  };
  methodIdentifiers?: Record<string, string>;
  rawMetadata?: string;
  metadata?: {
    compiler?: {
      version: string;
    };
    language?: string;
    output?: {
      abi?: any[];
      devdoc?: any;
      userdoc?: any;
    };
    settings?: {
      optimizer?: {
        enabled: boolean;
        runs: number;
      };
      evmVersion?: string;
      viaIR?: boolean;
      metadata?: {
        bytecodeHash?: string;
      };
      compilationTarget?: Record<string, string>;
    };
    sources?: Record<
      string,
      {
        keccak256?: string;
        license?: string;
        urls?: string[];
      }
    >;
    version?: number;
  };
  storageLayout?: {
    storage: any[];
    types: Record<string, any>;
  };
  userdoc?: any;
  devdoc?: any;
  ir?: string;
  irOptimized?: string;
  ewasm?: any;
}

export class FoundryPlugin extends CompilerPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "foundry",
      type: PluginType.COMPILER,
      name: "Foundry",
      version: PLUGIN_VERSION,
      baseImage: "ignite/compiler_foundry:latest",
    };
  }

  async detect(): Promise<PluginResponse<DetectionResult>> {
    try {
      const foundryTomlPath = join("/workspace", "foundry.toml");
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

  async install(): Promise<PluginResponse<NoResult>> {
    // First, update git submodules
    const submoduleResult = await execCommand(
      "git",
      ["submodule", "update", "--init", "--recursive"],
      "/workspace",
    );

    if (!submoduleResult.success) {
      return {
        success: false,
        error: {
          code: "GIT_SUBMODULE_FAILED",
          message: "Failed to update git submodules",
          details: submoduleResult.error?.details,
        },
      };
    }

    // Then run forge install
    const forgeResult = await execCommand("forge", ["install"], "/workspace");

    if (!forgeResult.success) {
      return {
        success: false,
        error: {
          code: "FORGE_INSTALL_FAILED",
          message: "Failed to run forge install",
          details: forgeResult.error?.details,
        },
      };
    }

    return {
      success: true,
      data: {},
    };
  }

  async compile(): Promise<PluginResponse<NoResult>> {
    const result = await execCommand("forge", ["build"], "/workspace");

    if (!result.success) {
      return {
        success: false,
        error: {
          code: "FORGE_BUILD_FAILED",
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

      // Parse foundry.toml to get the out directory (default: "out")
      const outDir = await this.getFoundryDir(workspaceRoot, "out");
      const artifactsPath = join(workspaceRoot, outDir);

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

      // Process each artifact file and read contents to check bytecode
      for (const file of artifactFiles) {
        // Validate and sanitize paths to prevent JSON corruption
        if (!file.relativePath) {
          continue; // Skip invalid entries
        }

        // Read and parse the artifact file
        const artifactData = await readJsonFile<FoundryArtifact>(file.path);
        if (!artifactData) {
          continue; // Skip if can't read or parse JSON
        }

        // Skip if bytecode is empty (0x means no deployable bytecode)
        if (
          !artifactData.bytecode?.object ||
          artifactData.bytecode.object === "0x"
        ) {
          continue;
        }

        // Extract source path from artifact metadata using compilationTarget
        const compilationTarget =
          artifactData.metadata?.settings?.compilationTarget;
        const sourcePaths = Object.keys(compilationTarget || {});
        for (const sourcePath of sourcePaths) {
          const contractName = compilationTarget?.[sourcePath] || "";

          // Validate final paths
          if (!contractName || !sourcePath || !file.relativePath) {
            continue; // Skip invalid entries
          }

          if (
            sourcePath.startsWith("test") ||
            sourcePath.startsWith("script") ||
            sourcePath.includes("forge-std")
          ) {
            continue;
          }

          const artifact: ArtifactLocation = {
            contractName: contractName.trim(),
            sourcePath: sourcePath.trim(),
            artifactPath: file.relativePath.trim(),
          };

          artifacts.push(artifact);
        }
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
      const artifactData = await readJsonFile<FoundryArtifact>(artifactPath);
      if (!artifactData) {
        return {
          success: false,
          error: {
            code: "ARTIFACT_PARSE_ERROR",
            message: `Failed to parse artifact file: ${options.artifactPath}`,
          },
        };
      }

      // Extract compilation settings from metadata
      const metadata = artifactData.metadata;
      const settings = metadata?.settings;
      const compiler = metadata?.compiler;

      // Parse link references for both creation and deployed bytecode
      const creationCodeLinkReferences = this.parseLinkReferences(
        artifactData.bytecode?.linkReferences,
      );
      const deployedBytecodeLinkReferences = this.parseLinkReferences(
        artifactData.deployedBytecode?.linkReferences,
      );

      const result: ArtifactData = {
        solidityVersion: compiler?.version || "unknown",
        optimizer: settings?.optimizer?.enabled || false,
        optimizerRuns: settings?.optimizer?.runs || 0,
        evmVersion: settings?.evmVersion,
        viaIR: settings?.viaIR || false,
        bytecodeHash: settings?.metadata?.bytecodeHash || "ipfs",
        abi: artifactData.abi || [],
        creationCode: artifactData.bytecode?.object || "0x",
        deployedBytecode: artifactData.deployedBytecode?.object || "0x",
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

  // Helper method to parse Foundry link references into our standard format
  private parseLinkReferences(linkRefs: any): LinkReferences | undefined {
    if (!linkRefs || typeof linkRefs !== "object") {
      return undefined;
    }

    const result: LinkReferences = {};

    // Foundry link references structure: { "path/file.sol": { "ContractName": [{ start: number, length: number }] } }
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

  // Parse foundry.toml to get the src directory
  // Returns "src" as default if file doesn't exist or can't be parsed
  private async getFoundryDir(
    workspaceRoot: string,
    dir: string,
    defaultDir: string = dir,
  ): Promise<string> {
    const foundryTomlPath = join(workspaceRoot, "foundry.toml");

    try {
      if (!(await fileExists(foundryTomlPath))) {
        return defaultDir; // Default
      }

      const tomlContent = await fs.readFile(foundryTomlPath, "utf-8");

      // Simple regex to extract the directory from foundry.toml
      // This is a basic implementation - a proper TOML parser would be better
      const dirMatch = tomlContent.match(
        new RegExp(`^\\s*${dir}\\s*=\\s*["']([^"']+)["']`, "m"),
      );

      if (dirMatch && dirMatch[1]) {
        return dirMatch[1];
      }

      return defaultDir; // Default if not found
    } catch (error) {
      return defaultDir; // Default on error
    }
  }
}

const plugin = new FoundryPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
runPluginCLI<CompilerOperation>(plugin);
