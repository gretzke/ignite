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

export type Hex = `0x${string}`;

// A fully-built transaction. Core owns construction; signers sign/submit it
// verbatim and never reinterpret calldata. Quantities are hex strings so the
// payload is JSON-safe end-to-end.
export interface UnsignedTx {
  chainId: number;
  to: Hex | null;
  data: Hex;
  value: Hex;
  nonce: number;
  gas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
}

// Chain display metadata passed to sign-and-send providers.
export interface ChainMetadata {
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

// Plugin metadata and configuration
export enum PluginType {
  COMPILER = "compiler",
  RPC_PROVIDER = "rpc-provider",
  SIGNER_PROVIDER = "signer-provider",
  VERIFIER = "verifier",
  DEPLOYMENT_TYPE = "deployment-type",
}

// Where a plugin's code executes. "container" (default when absent) runs in
// an ephemeral Docker container via PluginExecutor; "frontend" is declared so
// manifests and validation know the vocabulary, but installed frontend
// plugins have no execution backend yet.
export type PluginRuntime = "container" | "frontend";

// The permission vocabulary core can actually enforce (container mounts and
// network mode). Plugins request a subset in their manifest.
export type PluginPermissionId = "repoWrite" | "net";

export const PLUGIN_PERMISSION_IDS: readonly PluginPermissionId[] = [
  "repoWrite",
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
  | "file"
  | "list";

export interface PluginConfigSelectOption {
  value: string;
  label: string;
}

// One column of a `list` config field's items. v1: strings only. Secret item
// values live in the vault under `${fieldKey}.${itemId}.${itemFieldKey}`.
export interface PluginConfigListItemField {
  key: string;
  label: string;
  type: "string";
  secret?: boolean;
  required?: boolean;
}

export const MAX_LIST_ITEMS = 64;
export const LIST_ITEM_ID_PATTERN = /^[a-z0-9]{4,16}$/;

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
  itemFields?: PluginConfigListItemField[]; // required iff type === "list"
}

// Upper bound on how many config fields a plugin manifest may declare.
export const MAX_CONFIG_FIELDS = 32;

// The single definition of "this config field is secret-scoped": its value
// (or file contents / per-item secret values) only ever flows to the plugin
// under a secret-scope grant covering the field's key. Every scope surface —
// trust grants, grant clamping on update, the grant dialogs, config payloads —
// MUST use this predicate; a site that hand-rolls it will silently disagree
// on which fields are grantable (list fields were missed exactly this way).
export function isSecretScopeField(field: PluginConfigField): boolean {
  return (
    field.secret === true ||
    field.type === "file" ||
    (field.type === "list" &&
      (field.itemFields ?? []).some((item) => item.secret === true))
  );
}

export interface PluginMetadata {
  id: string;
  // Capability surfaces this plugin implements. types[0] is the primary type:
  // for builtin plugins it must equal the src/<dir> the plugin lives in
  // (bundle assets are named `<primaryType>_<name>.js`).
  types: PluginType[];
  runtime?: PluginRuntime;
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
  // Operations exposed through the generic dispatch surface. Omitted legacy
  // manifests are normalized by core to frozen per-type baselines.
  operations?: string[];
  // Optional pre-flight permission hints for individual operations.
  operationPermissions?: Record<string, PluginPermissionId>;
  // Whether this plugin needs a read-only (unless repoWrite is granted)
  // workspace bind mount. Core normalizes omitted legacy manifests.
  repoRead?: boolean;
  // Hash of the Dockerfiles the baseImage was built from (set at registry
  // generation); compared against the image's ignite.dockerfileHash label
  // to detect stale images
  imageHash?: string;
}

export interface PathOptions {
  pathOrUrl: string;
}
