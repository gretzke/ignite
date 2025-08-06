// Core plugin types
export interface PluginResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Plugin metadata and configuration
export enum PluginType {
  REPO_MANAGER = "repo-manager",
  COMPILER = "compiler",
}

export interface PluginMetadata {
  id: string;
  type: PluginType;
  name: string;
  version: string;
  baseImage: string;
}
