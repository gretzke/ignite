// Throwaway stub compiler used only to verify the third-party plugin runtime.
// NOT shipped in the built-in catalog (lives under plugins/examples/).
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  CompilerPlugin,
  PluginType,
  type PluginMetadata,
  type DetectionResult,
  type PluginResponse,
  type NoResult,
  type ArtifactListResult,
  type GetArtifactDataOptions,
  type ArtifactData,
  type WatchPathsResult,
} from '../../src/shared/index.ts';
import { runPluginCLI } from '../../src/shared/plugin-runner.js';

declare const PLUGIN_VERSION: string;

export class StubCompilerPlugin extends CompilerPlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: 'stub-compiler',
      type: PluginType.COMPILER,
      name: 'Stub Compiler',
      version: typeof PLUGIN_VERSION === 'string' ? PLUGIN_VERSION : '0.0.1',
      baseImage: 'ignite/installed_stub-compiler:0.0.1',
      permissions: [
        {
          id: 'hostWrite',
          description:
            'Write marker files into the workspace to prove hostWrite works.',
        },
      ],
    };
  }

  async detect(): Promise<PluginResponse<DetectionResult>> {
    return { success: true, data: { detected: true } };
  }

  async install(): Promise<PluginResponse<NoResult>> {
    return { success: true, data: {} as NoResult };
  }

  async compile(): Promise<PluginResponse<NoResult>> {
    // Prove hostWrite: write a marker into the shared workspace volume.
    try {
      await fs.writeFile(
        join('/workspace', '.stub-compiler-ran'),
        new Date().toISOString()
      );

      // Prove the per-plugin cache volume persists across ephemeral
      // containers: bump a counter in /cache and mirror it into the
      // workspace, where the host (and the integration test) can read it.
      const cacheDir = process.env.IGNITE_PLUGIN_CACHE;
      if (cacheDir) {
        const counterPath = join(cacheDir, 'compile-count');
        let count = 0;
        try {
          count = parseInt(await fs.readFile(counterPath, 'utf8'), 10) || 0;
        } catch {
          // first run: no counter yet
        }
        count += 1;
        await fs.writeFile(counterPath, String(count));
        await fs.writeFile(
          join('/workspace', '.stub-compiler-cache-count'),
          String(count)
        );
      }
      return { success: true, data: {} as NoResult };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'STUB_COMPILE_FAILED',
          message: `Stub compile could not write workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }

  async listArtifacts(): Promise<PluginResponse<ArtifactListResult>> {
    return { success: true, data: { artifacts: [] } };
  }

  async getArtifactData(
    _options: GetArtifactDataOptions
  ): Promise<PluginResponse<ArtifactData>> {
    return {
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Stub compiler produces no artifacts',
      },
    };
  }

  async getWatchPaths(): Promise<PluginResponse<WatchPathsResult>> {
    // Reference implementation: the marker file this stub reads/writes is
    // the only workspace state it depends on.
    return {
      success: true,
      data: { config: [], sources: ['.stub-compiler'], artifacts: [] },
    };
  }
}

const plugin = new StubCompilerPlugin();
export default plugin;

runPluginCLI(plugin);
