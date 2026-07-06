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

// The permission vocabulary core can actually enforce (container mounts and
// network mode). Plugins request a subset in their manifest.
export type PluginPermissionId = "hostWrite" | "net";

export const PLUGIN_PERMISSION_IDS: readonly PluginPermissionId[] = [
  "hostWrite",
  "net",
];

// A manifest-declared permission request: the plugin says which permission it
// needs and why. The description is shown to the user in the grant dialog —
// core treats it as untrusted text (validated at install, rendered as plain
// text).
export interface PluginPermissionRequest {
  id: PluginPermissionId;
  description: string;
}

export interface PluginMetadata {
  id: string;
  type: PluginType;
  name: string;
  version: string;
  baseImage: string;
  // Permissions this plugin requests, with user-facing justifications.
  // Undeclared permissions can never be granted: operations that need one
  // fail hard instead of prompting.
  permissions?: PluginPermissionRequest[];
  // Hash of the Dockerfiles the baseImage was built from (set at registry
  // generation); compared against the image's ignite.dockerfileHash label
  // to detect stale images
  imageHash?: string;
}

export interface PathOptions {
  pathOrUrl: string;
}
