// MVP Foundry Detection Plugin
import { promises as fs } from "fs";
import { basename, dirname, join } from "path";
import { parse as parseToml } from "smol-toml";
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
  type GetVerificationBundleOptions,
  type LinkReferences,
  type VerificationBundleData,
  type WatchPathsResult,
} from "../../shared/index.ts";
import { execCommand } from "../../shared/utils/exec.js";
import { execFailureMessage } from "../../shared/utils/format-error.js";
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

export function foundryContractIdentifier(
  artifact: FoundryArtifact,
): string | null {
  const targets = artifact.metadata?.settings?.compilationTarget;
  const [sourcePath, contractName] = Object.entries(targets ?? {})[0] ?? [];
  if (!sourcePath || !contractName) return null;
  return `${sourcePath}:${contractName}`;
}

export function parseFoundryStandardJsonInput(stdout: string): unknown | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export function withVersionPrefix(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * Foundry writes profile variants alongside the primary artifact in the
 * source's `.sol` directory. Metadata describes the compilation, but is not
 * an identity-safe source for the profile suffix, so this deliberately reads
 * only that filename.
 */
export function parseFoundryArtifactVariant(
  artifactPath: string,
  sourcePath: string,
  contractName: string,
): ArtifactLocation["variant"] | undefined {
  if (basename(dirname(artifactPath)) !== basename(sourcePath)) {
    return undefined;
  }

  const fileStem = basename(artifactPath, ".json");
  if (fileStem !== contractName && !fileStem.startsWith(`${contractName}.`)) {
    return undefined;
  }

  const suffix = fileStem.slice(contractName.length + 1);
  if (!suffix) return undefined;

  if (/^\d+\.\d+\.\d+$/.test(suffix)) {
    return { solcVersion: suffix };
  }
  const versionAndProfile = suffix.match(/^(\d+\.\d+\.\d+)\.(.+)$/);
  if (versionAndProfile) {
    return { solcVersion: versionAndProfile[1], profile: versionAndProfile[2] };
  }

  return { profile: suffix };
}

export class FoundryPlugin extends CompilerPlugin {
  // Static metadata for registry generation (no instantiation needed)
  protected static getMetadata(): PluginMetadata {
    return {
      id: "foundry",
      types: [PluginType.COMPILER],
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
          message: execFailureMessage(
            "Failed to update git submodules",
            submoduleResult,
          ),
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
          message: execFailureMessage("forge install failed", forgeResult),
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
          message: execFailureMessage("Compilation failed", result),
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
        const targets = Object.entries(compilationTarget ?? {});
        if (targets.length > 1) {
          console.warn(
            `Skipping Foundry artifact ${file.relativePath}: compilationTarget has multiple entries`,
          );
          continue;
        }

        for (const [sourcePath, contractName] of targets) {

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

          const variant = parseFoundryArtifactVariant(
            file.relativePath,
            sourcePath,
            contractName,
          );
          const artifact: ArtifactLocation = {
            contractName: contractName.trim(),
            sourcePath: sourcePath.trim(),
            artifactPath: file.relativePath.trim(),
            ...(variant && { variant }),
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

  async getVerificationBundle(
    options: GetVerificationBundleOptions,
  ): Promise<PluginResponse<VerificationBundleData>> {
    try {
      const artifactPath = join("/workspace", options.artifactPath);
      const artifact = await readJsonFile<FoundryArtifact>(artifactPath);
      if (!artifact) return bundleUnavailable(`Failed to parse artifact: ${options.artifactPath}`);

      const contractIdentifier = foundryContractIdentifier(artifact);
      const solcVersion = artifact.metadata?.compiler?.version;
      const creationCode = artifact.bytecode?.object;
      if (!contractIdentifier || !solcVersion || !creationCode) {
        return bundleUnavailable(
          `Artifact does not contain verification bundle metadata: ${options.artifactPath}`,
        );
      }

      const command = await execCommand(
        "forge",
        [
          "verify-contract",
          "0x0000000000000000000000000000000000000000",
          contractIdentifier,
          "--show-standard-json-input",
        ],
        "/workspace",
      );
      if (!command.success) {
        return bundleUnavailable(
          `Failed to obtain standard JSON input for ${contractIdentifier}`,
          command.error?.details,
        );
      }

      const standardJsonInput = parseFoundryStandardJsonInput(command.data.stdout);
      if (!standardJsonInput) {
        return bundleUnavailable(
          `Forge returned invalid standard JSON input for ${contractIdentifier}`,
        );
      }

      return {
        success: true,
        data: {
          standardJsonInput,
          solcVersion: withVersionPrefix(solcVersion),
          contractIdentifier,
          creationCode,
        },
      };
    } catch (error) {
      return bundleUnavailable(
        `Failed to obtain verification bundle: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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

  // Parse foundry.toml to resolve a profile setting, honoring FOUNDRY_PROFILE
  // with fallback to the default profile. Returns undefined when the file or
  // key is absent or unparseable.
  private async getFoundryValue(
    workspaceRoot: string,
    key: string,
  ): Promise<unknown> {
    const foundryTomlPath = join(workspaceRoot, "foundry.toml");

    try {
      if (!(await fileExists(foundryTomlPath))) {
        return undefined;
      }

      const tomlContent = await fs.readFile(foundryTomlPath, "utf-8");
      const config = parseToml(tomlContent) as {
        profile?: Record<string, Record<string, unknown>>;
      };

      const profileName = process.env.FOUNDRY_PROFILE || "default";
      return (
        config.profile?.[profileName]?.[key] ?? config.profile?.default?.[key]
      );
    } catch {
      return undefined;
    }
  }

  // Parse foundry.toml to resolve a directory setting (e.g. "out", "src")
  private async getFoundryDir(
    workspaceRoot: string,
    dir: string,
    defaultDir: string = dir,
  ): Promise<string> {
    const value = await this.getFoundryValue(workspaceRoot, dir);
    return typeof value === "string" ? value : defaultDir;
  }

  async getWatchPaths(): Promise<PluginResponse<WatchPathsResult>> {
    try {
      const ws = "/workspace";
      const src = await this.getFoundryDir(ws, "src");
      const out = await this.getFoundryDir(ws, "out");
      const test = await this.getFoundryDir(ws, "test");
      const script = await this.getFoundryDir(ws, "script");
      const libsValue = await this.getFoundryValue(ws, "libs");
      const libs =
        Array.isArray(libsValue) &&
        libsValue.every((l) => typeof l === "string") &&
        libsValue.length > 0
          ? (libsValue as string[])
          : ["lib"];

      return {
        success: true,
        data: {
          config: ["foundry.toml", "remappings.txt"],
          sources: [src, test, script, ...libs],
          artifacts: [out],
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "WATCH_PATHS_ERROR",
          message: `Failed to resolve watch paths: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
}

function bundleUnavailable(
  message: string,
  details?: Record<string, unknown>,
): PluginResponse<never> {
  return {
    success: false,
    error: { code: "BUNDLE_UNAVAILABLE", message, details },
  };
}

const plugin = new FoundryPlugin();

// Export plugin instance as default for registry generation
export default plugin;

// CLI entrypoint - type-safe generic plugin execution
runPluginCLI<CompilerOperation>(plugin);
