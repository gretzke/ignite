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
  RPC_PROVIDER = "rpc-provider",
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

// A single field in a plugin's declared config schema, rendered as a form
// control in the settings UI. `secret` fields are stored in the vault,
// gated by a secret-scope grant; `perChain` fields get a global value plus
// per-chain overrides. `file` fields store a host file PATH (plaintext, in
// the same non-secret config store as string fields) — core reads the file
// at that path and injects its CONTENTS under the field's key, gated by the
// same secret-scope grant dimension as `secret` fields (see resolveConfig).
export type PluginConfigFieldType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "file";

export interface PluginConfigSelectOption {
  value: string;
  label: string;
}

export interface PluginConfigField {
  key: string; // stable identifier, ^[a-z0-9][a-z0-9._-]*$
  label: string; // shown in the settings form
  type: PluginConfigFieldType;
  description?: string; // help text
  secret?: boolean; // stored in the vault, gated by a secret-scope grant
  perChain?: boolean; // global value + per-chain overrides
  required?: boolean;
  options?: PluginConfigSelectOption[]; // required iff type === "select"
  default?: string; // file fields only: default host path (e.g. "~/.foo.json")
}

// Upper bound on how many config fields a plugin manifest may declare.
export const MAX_CONFIG_FIELDS = 32;

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
  // Config fields this plugin exposes in the settings UI (see
  // PluginConfigField above).
  configFields?: PluginConfigField[];
  // Hash of the Dockerfiles the baseImage was built from (set at registry
  // generation); compared against the image's ignite.dockerfileHash label
  // to detect stale images
  imageHash?: string;
}

export interface PathOptions {
  pathOrUrl: string;
}
