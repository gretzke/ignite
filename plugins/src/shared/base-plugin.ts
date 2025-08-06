import { PluginResult, PluginMetadata, PluginType } from "./types.js";

// Base class for all Ignite plugins
export abstract class BasePlugin<T extends PluginType = PluginType> {
  public readonly metadata: PluginMetadata;

  constructor(metadata: PluginMetadata) {
    this.metadata = metadata;
  }

  // Core plugin information
  getInfo(): PluginResult<{ name: string; version: string; type: T }> {
    return {
      success: true,
      data: {
        name: this.metadata.name,
        version: this.metadata.version,
        type: this.metadata.type as T,
      },
    };
  }

  // Plugin metadata access
  getId(): string {
    return this.metadata.id;
  }

  getType(): T {
    return this.metadata.type as T;
  }

  getBaseImage(): string {
    return this.metadata.baseImage;
  }
}
