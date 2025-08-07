import { AssetManager } from './AssetManager.js';
import { getLogger } from '../utils/logger.js';

// PluginAssetLoader - Loads plugin bundles using the unified AssetManager
// Handles both development and production (pkg bundled) modes consistently
export class PluginAssetLoader {
  private static instance: PluginAssetLoader;
  private assetManager: AssetManager;

  private constructor() {
    this.assetManager = AssetManager.getInstance();
  }

  static getInstance(): PluginAssetLoader {
    if (!PluginAssetLoader.instance) {
      PluginAssetLoader.instance = new PluginAssetLoader();
    }
    return PluginAssetLoader.instance;
  }

  // Load a plugin's JavaScript code
  // @param pluginType - The plugin type (e.g., 'compiler', 'repo-manager')
  // @param pluginId - The plugin ID (e.g., 'foundry', 'local-repo')
  // @returns The plugin JavaScript code as a string
  async loadPlugin(pluginType: string, pluginId: string): Promise<string> {
    const assetPath = `plugins/dist/compressed/${pluginType}_${pluginId}.js.gz`;

    try {
      getLogger().info(
        `🔌 Loading plugin: ${pluginType}/${pluginId} from ${assetPath}`
      );

      if (!this.assetManager.exists(assetPath)) {
        throw new Error(`Plugin asset not found: ${assetPath}`);
      }

      const content = this.assetManager.getAssetText(assetPath);

      getLogger().info(
        `✅ Plugin ${pluginType}/${pluginId} loaded (${content.length} chars)`
      );

      return content;
    } catch (error) {
      getLogger().error(
        `Failed to load plugin ${pluginType}/${pluginId}:`,
        error
      );
      throw new Error(`Plugin ${pluginType}/${pluginId} not found: ${error}`);
    }
  }

  // Check if a plugin exists
  // @param pluginType - The plugin type
  // @param pluginId - The plugin ID
  // @returns True if the plugin exists
  pluginExists(pluginType: string, pluginId: string): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pkg property not in Node.js types
    const isPkgBundled = typeof (process as any).pkg !== 'undefined';

    const assetPath = isPkgBundled
      ? `plugins/${pluginType}_${pluginId}.js.gz`
      : `plugins/dist/compressed/${pluginType}_${pluginId}.js.gz`;

    return this.assetManager.exists(assetPath);
  }
}
