import { PluginResult, PluginMetadata, PluginType } from "./types.js";

// Base class for all Ignite plugins
export abstract class BasePlugin<T extends PluginType = PluginType> {
  // Static method for metadata - wraps getMetadata in PluginResult
  static getInfo(): PluginResult<PluginMetadata> {
    return {
      success: true,
      data: this.getMetadata(),
    };
  }

  // Abstract static method that must be implemented by inheriting classes
  protected static getMetadata(): PluginMetadata {
    throw new Error("getMetadata() must be implemented by plugin class");
  }

  // Instance method delegates to static for backwards compatibility
  getInfo(): PluginResult<PluginMetadata> {
    return (this.constructor as typeof BasePlugin).getInfo();
  }

  // Plugin metadata access
  getId(): string {
    return BasePlugin.getMetadata().id;
  }

  getType(): T {
    return BasePlugin.getMetadata().type as T;
  }

  getBaseImage(): string {
    return BasePlugin.getMetadata().baseImage;
  }
}
