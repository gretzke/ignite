import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  DeletePluginConfigQuery,
  GetPluginConfigData,
  PluginConfigField,
  PluginPermissionRequest,
  PluginVersionInfoData,
  SetPluginConfigValueRequest,
  SetPluginSecretRequest,
  StorePluginData,
  UpsertPluginConfigListItemRequest,
} from '@ignite/api';
import type { ApiError } from '@ignite/api/client';
import { apiClient, apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { formatApiError } from '../../middleware/apiGate';
import { jobStarted } from '../jobs/jobsSlice';
import { discoverActiveJobs } from '../jobs/discoverJobs';
import { wsSend } from '../../middleware/websocket';
import type { RootState } from '../../store';

export interface PluginPermissions {
  repoWrite: boolean;
  net: boolean;
  contractBytecode: boolean;
  // Granted secret config-field keys (see PluginConfigField.secret).
  secrets: string[];
}

export interface PluginRow {
  pluginId: string;
  name?: string;
  types: string[];
  version?: string;
  trust: 'native' | 'trusted' | 'untrusted';
  permissions: PluginPermissions;
  // Manifest-declared permission requests (with user-facing descriptions).
  // Only these can be granted.
  requested: PluginPermissionRequest[];
  // Manifest-declared config fields (settings-form schema), if any.
  configFields?: PluginConfigField[];
  // Effective metadata served by the API: repository reads are inherent to
  // container plugins and therefore informational rather than grantable.
  repoRead?: boolean;
}

// Drives the global permissions modal: opened from a plugin card, after an
// install (every requested permission is new), or after an update (only the
// newly requested ones are highlighted).
export interface PermissionsModalState {
  pluginId: string;
  newPermissionIds: string[];
}

// Drives the global plugin config modal, opened from a plugin card's
// Configure button.
export interface ConfigModalState {
  pluginId: string;
}

interface PluginsState {
  rows: Record<string, PluginRow>;
  loading: boolean;
  devMode: boolean;
  permissionsModal: PermissionsModalState | null;
  configModal: ConfigModalState | null;
  // Version/update info per installed plugin (from /plugins/versions).
  versions: Record<string, PluginVersionInfoData>;
  // Curated store catalog; null until first fetched.
  storePlugins: StorePluginData[] | null;
  // Config schema + current values per plugin, fetched on-demand when the
  // config modal opens.
  configByPlugin: Record<string, GetPluginConfigData>;
}

const initialState: PluginsState = {
  rows: {},
  loading: false,
  devMode: false,
  permissionsModal: null,
  configModal: null,
  versions: {},
  storePlugins: null,
  configByPlugin: {},
};

const pluginsSlice = createSlice({
  name: 'plugins',
  initialState,
  reducers: {
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    setDevMode(state, action: PayloadAction<boolean>) {
      state.devMode = action.payload;
    },
    setMetadata(
      state,
      action: PayloadAction<
        Record<
          string,
          {
            name: string;
            types: string[];
            version: string;
            requested: PluginPermissionRequest[];
            configFields?: PluginConfigField[];
            repoRead?: boolean;
          }
        >
      >
    ) {
      for (const [id, m] of Object.entries(action.payload)) {
        state.rows[id] = {
          ...state.rows[id],
          pluginId: id,
          trust: state.rows[id]?.trust ?? 'untrusted',
          permissions: state.rows[id]?.permissions ?? {
            repoWrite: false,
            net: false,
            contractBytecode: false,
            secrets: [],
          },
          name: m.name,
          types: m.types,
          version: m.version,
          requested: m.requested,
          configFields: m.configFields,
          repoRead: m.repoRead,
        };
      }
    },
    openPermissionsModal(state, action: PayloadAction<PermissionsModalState>) {
      state.permissionsModal = action.payload;
    },
    closePermissionsModal(state) {
      state.permissionsModal = null;
    },
    openConfigModal(state, action: PayloadAction<ConfigModalState>) {
      state.configModal = action.payload;
    },
    closeConfigModal(state) {
      state.configModal = null;
    },
    configReceived(
      state,
      action: PayloadAction<{ pluginId: string; config: GetPluginConfigData }>
    ) {
      state.configByPlugin[action.payload.pluginId] = action.payload.config;
    },
    setVersions(state, action: PayloadAction<PluginVersionInfoData[]>) {
      state.versions = Object.fromEntries(
        action.payload.map((info) => [info.pluginId, info])
      );
    },
    setStorePlugins(state, action: PayloadAction<StorePluginData[]>) {
      state.storePlugins = action.payload;
    },
    setTrust(
      state,
      action: PayloadAction<
        Array<{
          pluginId: string;
          trust: 'native' | 'trusted' | 'untrusted';
          permissions: PluginPermissions;
        }>
      >
    ) {
      for (const t of action.payload) {
        state.rows[t.pluginId] = {
          ...state.rows[t.pluginId],
          pluginId: t.pluginId,
          trust: t.trust,
          permissions: t.permissions,
          requested: state.rows[t.pluginId]?.requested ?? [],
          types: state.rows[t.pluginId]?.types ?? [],
        };
      }
    },
    removeRow(state, action: PayloadAction<string>) {
      delete state.rows[action.payload];
    },
  },
});

export const {
  setLoading,
  setDevMode,
  setMetadata,
  setTrust,
  removeRow,
  openPermissionsModal,
  closePermissionsModal,
  openConfigModal,
  closeConfigModal,
  configReceived,
  setVersions,
  setStorePlugins,
} = pluginsSlice.actions;
export const selectPluginRows = (s: RootState) => Object.values(s.plugins.rows);
export const selectPluginsLoading = (s: RootState) => s.plugins.loading;
export const selectDevMode = (s: RootState) => s.plugins.devMode;
export const selectPermissionsModal = (s: RootState) =>
  s.plugins.permissionsModal;
export const selectConfigModal = (s: RootState) => s.plugins.configModal;
export const selectPluginRow = (s: RootState, pluginId: string) =>
  s.plugins.rows[pluginId];
export const selectPluginConfig = (s: RootState, pluginId: string) =>
  s.plugins.configByPlugin[pluginId];
export const selectPluginVersions = (s: RootState) => s.plugins.versions;
export const selectStorePlugins = (s: RootState) => s.plugins.storePlugins;
export const pluginsReducer = pluginsSlice.reducer;

// A git install target chosen in the install modal.
export interface GitInstallTarget {
  url: string;
  ref?: string;
  track?:
    | { mode: 'release'; version: string }
    | { mode: 'branch'; branch: string }
    | { mode: 'commit' };
}

// API actions using the enhanced client (following the repositories/profiles pattern)
export const pluginsApi = {
  refresh() {
    return [
      setLoading(true),
      apiClient.dispatch.systemInfo({
        onSuccess: (data) => [setDevMode(data.devMode)],
      }),
      apiClient.dispatch.listPlugins({
        onSuccess: (data) => [
          setMetadata(
            Object.fromEntries(
              Object.entries(data.plugins).map(([id, m]) => [
                id,
                {
                  name: m.name,
                  types: m.types,
                  version: m.version,
                  requested: m.permissions ?? [],
                  configFields: m.configFields,
                  repoRead: m.repoRead,
                },
              ])
            )
          ),
        ],
        onError: (error) => {
          const { title, description } = formatApiError(error);
          return [
            setLoading(false),
            triggerToast({
              title,
              description,
              variant: 'error',
              duration: 5000,
            }),
          ];
        },
      }),
      apiClient.dispatch.listPluginTrust({
        onSuccess: (data) => [
          setTrust(
            data.plugins.map((p) => ({
              ...p,
              permissions: {
                ...p.permissions,
                secrets: p.permissions.secrets ?? [],
              },
            }))
          ),
          setLoading(false),
        ],
        onError: (error) => {
          const { title, description } = formatApiError(error);
          return [
            setLoading(false),
            triggerToast({
              title,
              description,
              variant: 'error',
              duration: 5000,
            }),
          ];
        },
      }),
      // Update-availability check: silent on failure (offline is fine).
      apiClient.dispatch.pluginVersions({
        onSuccess: (data) => [setVersions(data.plugins)],
        onError: () => [],
      }),
    ];
  },
  fetchStore() {
    return apiClient.dispatch.pluginStore({
      onSuccess: (data) => [setStorePlugins(data.plugins)],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 5000,
          }),
        ];
      },
    });
  },
  setPermissions(
    pluginId: string,
    trust: 'trusted' | 'untrusted',
    permissions: { repoWrite: boolean; net: boolean; contractBytecode: boolean; secrets: string[] }
  ) {
    return apiClient.dispatch.setPluginTrust({
      params: { pluginId },
      body: { trust, permissions },
      onSuccess: () => pluginsApi.refresh(),
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 5000,
          }),
        ];
      },
    });
  },
  // Request success only means the plugin.install job was created; the
  // "Plugin installed" toast + list refresh now happen in jobsEffects once
  // the job reaches a terminal state (also handles PERMISSION_REQUIRED
  // denials, which surface as failed jobs rather than HTTP errors).
  install(contextDir: string, dockerfile?: string) {
    const source = dockerfile
      ? ({ kind: 'local', contextDir, dockerfile } as const)
      : ({ kind: 'local', contextDir } as const);
    return apiClient.dispatch.installPlugin({
      body: { source },
      onSuccess: (data) => [
        jobStarted({
          jobId: data.jobId,
          type: 'plugin.install',
          params: { source },
        }),
        wsSend({ type: 'subscribe', jobId: data.jobId }),
        triggerToast({
          id: `plugin-job-${data.jobId}`,
          title: 'Installing plugin…',
          description:
            'Building the plugin image. This can take a few minutes.',
          variant: 'info',
          permanent: true,
        }),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 6000,
          }),
        ];
      },
    });
  },
  installGit(target: GitInstallTarget) {
    const source = { kind: 'git' as const, ...target };
    return apiClient.dispatch.installPlugin({
      body: { source },
      onSuccess: (data) => [
        jobStarted({
          jobId: data.jobId,
          type: 'plugin.install',
          params: { source },
        }),
        wsSend({ type: 'subscribe', jobId: data.jobId }),
        triggerToast({
          id: `plugin-job-${data.jobId}`,
          title: 'Installing plugin…',
          description:
            'Building the plugin image. This can take a few minutes.',
          variant: 'info',
          permanent: true,
        }),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 6000,
          }),
        ];
      },
    });
  },
  // Rebuild the plugin. Without a target: from its stored install source.
  // With a target (update button, version switch): from the same repo at the
  // given ref — the server rejects any other repo, so grants can't leak.
  // Completion (and the new-permissions prompt) is handled in jobsEffects.
  update(pluginId: string, target?: GitInstallTarget) {
    return apiClient.dispatch.updatePlugin({
      params: { pluginId },
      body: target ? { source: { kind: 'git' as const, ...target } } : {},
      onSuccess: (data) => [
        jobStarted({
          jobId: data.jobId,
          type: 'plugin.update',
          params: { pluginId },
        }),
        wsSend({ type: 'subscribe', jobId: data.jobId }),
        triggerToast({
          id: `plugin-job-${data.jobId}`,
          title: 'Updating plugin…',
          description:
            'Rebuilding the plugin image. This can take a few minutes.',
          variant: 'info',
          permanent: true,
        }),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 6000,
          }),
        ];
      },
    });
  },
  uninstall(pluginId: string) {
    return apiClient.dispatch.uninstallPlugin({
      params: { pluginId },
      onSuccess: () => [
        removeRow(pluginId),
        ...pluginsApi.refresh(),
        // Uninstall also triggers a server-side re-detection sweep.
        discoverActiveJobs(),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 5000,
          }),
        ];
      },
    });
  },
  // Fetches a plugin's config schema + current values. Not toast-wrapped —
  // called silently whenever the config modal opens.
  fetchConfig(pluginId: string) {
    return apiClient.dispatch.getPluginConfig({
      params: { pluginId },
      onSuccess: (data) => [configReceived({ pluginId, config: data })],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({
            title,
            description,
            variant: 'error',
            duration: 5000,
          }),
        ];
      },
    });
  },
  // Writes a non-secret config value (global or per-chain). The response is
  // the refreshed config payload, so it's dispatched straight into
  // configByPlugin instead of triggering a separate refetch.
  setConfigValue(pluginId: string, body: SetPluginConfigValueRequest) {
    const apiAction = apiClient.dispatch.setPluginConfigValue({
      params: { pluginId },
      body,
      onSuccess: (data) => configReceived({ pluginId, config: data }),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: { title: 'Saving value…', variant: 'info' },
      onSuccess: () => ({
        title: 'Value saved',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },
  // Writes a secret value to the vault. The value itself is never echoed
  // back — only secretsPresent/grantedSecrets change in the response.
  setSecret(pluginId: string, body: SetPluginSecretRequest) {
    const apiAction = apiClient.dispatch.setPluginSecret({
      params: { pluginId },
      body,
      onSuccess: (data) => configReceived({ pluginId, config: data }),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: { title: 'Saving secret…', variant: 'info' },
      onSuccess: () => ({
        title: 'Secret saved',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },
  // Writes one item inside a list config field. Non-secret values merge into
  // the stored item; secret values go to the vault and are only reflected via
  // secretsPresent in the refreshed config payload.
  upsertConfigListItem(
    pluginId: string,
    body: UpsertPluginConfigListItemRequest
  ) {
    const apiAction = apiClient.dispatch.upsertPluginConfigListItem({
      params: { pluginId },
      body,
      onSuccess: (data) => configReceived({ pluginId, config: data }),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: { title: 'Saving item…', variant: 'info' },
      onSuccess: () => ({
        title: 'Item saved',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },
  deleteConfigListItem(pluginId: string, fieldKey: string, itemId: string) {
    const apiAction = apiClient.dispatch.deletePluginConfigListItem({
      params: { pluginId },
      query: { fieldKey, itemId },
      onSuccess: (data) => configReceived({ pluginId, config: data }),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: { title: 'Removing item…', variant: 'info' },
      onSuccess: () => ({
        title: 'Item removed',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },
  deleteConfigValue(pluginId: string, key: string, chainId?: number) {
    const query: DeletePluginConfigQuery = { key, chainId };
    const apiAction = apiClient.dispatch.deletePluginConfigValue({
      params: { pluginId },
      query,
      onSuccess: (data) => configReceived({ pluginId, config: data }),
    });
    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: { title: 'Removing value…', variant: 'info' },
      onSuccess: () => ({
        title: 'Value removed',
        variant: 'success',
        duration: 3000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return { title, description, variant: 'error', duration: 6000 };
      },
    });
  },
};

// Display name for a verifier plugin id, for UI rows that identify the
// handling plugin (explorer step pill, verification panel, review overview).
export function verifierPluginLabel(
  rows: Record<string, { name?: string }>,
  pluginId: string | undefined
): string {
  if (!pluginId) return 'Unknown verifier';
  return rows[pluginId]?.name ?? pluginId;
}
