export interface IApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type PluginResponse<T> =
  | {
      success: true;
      data: T;
    }
  | IApiError;

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

export interface PathOptions {
  pathOrUrl: string;
}
