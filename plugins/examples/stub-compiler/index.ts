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
}

const plugin = new StubCompilerPlugin();
export default plugin;

runPluginCLI(plugin);
