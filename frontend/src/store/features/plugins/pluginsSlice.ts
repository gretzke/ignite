import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  PluginPermissionRequest,
  PluginVersionInfoData,
  StorePluginData,
} from '@ignite/api';
import { apiClient } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { formatApiError } from '../../middleware/apiGate';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';
import type { RootState } from '../../store';

export interface PluginRow {
  pluginId: string;
  name?: string;
  type?: string;
  version?: string;
  trust: 'native' | 'trusted' | 'untrusted';
  permissions: { hostWrite: boolean; net: boolean };
  // Manifest-declared permission requests (with user-facing descriptions).
  // Only these can be granted.
  requested: PluginPermissionRequest[];
}

// Drives the global permissions modal: opened from a plugin card, after an
// install (every requested permission is new), or after an update (only the
// newly requested ones are highlighted).
export interface PermissionsModalState {
  pluginId: string;
  newPermissionIds: string[];
}

interface PluginsState {
  rows: Record<string, PluginRow>;
  loading: boolean;
  devMode: boolean;
  permissionsModal: PermissionsModalState | null;
  // Version/update info per installed plugin (from /plugins/versions).
  versions: Record<string, PluginVersionInfoData>;
  // Curated store catalog; null until first fetched.
  storePlugins: StorePluginData[] | null;
}

const initialState: PluginsState = {
  rows: {},
  loading: false,
  devMode: false,
  permissionsModal: null,
  versions: {},
  storePlugins: null,
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
            type: string;
            version: string;
            requested: PluginPermissionRequest[];
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
            hostWrite: false,
            net: false,
          },
          name: m.name,
          type: m.type,
          version: m.version,
          requested: m.requested,
        };
      }
    },
    openPermissionsModal(state, action: PayloadAction<PermissionsModalState>) {
      state.permissionsModal = action.payload;
    },
    closePermissionsModal(state) {
      state.permissionsModal = null;
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
          permissions: { hostWrite: boolean; net: boolean };
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
  setVersions,
  setStorePlugins,
} = pluginsSlice.actions;
export const selectPluginRows = (s: RootState) =>
  Object.values(s.plugins.rows);
export const selectPluginsLoading = (s: RootState) => s.plugins.loading;
export const selectDevMode = (s: RootState) => s.plugins.devMode;
export const selectPermissionsModal = (s: RootState) =>
  s.plugins.permissionsModal;
export const selectPluginRow = (s: RootState, pluginId: string) =>
  s.plugins.rows[pluginId];
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
                  type: m.type,
                  version: m.version,
                  requested: m.permissions ?? [],
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
        onSuccess: (data) => [setTrust(data.plugins), setLoading(false)],
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
          triggerToast({ title, description, variant: 'error', duration: 5000 }),
        ];
      },
    });
  },
  setPermissions(
    pluginId: string,
    trust: 'trusted' | 'untrusted',
    permissions: { hostWrite: boolean; net: boolean }
  ) {
    return apiClient.dispatch.setPluginTrust({
      params: { pluginId },
      body: { trust, permissions },
      onSuccess: () => pluginsApi.refresh(),
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({ title, description, variant: 'error', duration: 5000 }),
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
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({ title, description, variant: 'error', duration: 6000 }),
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
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({ title, description, variant: 'error', duration: 6000 }),
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
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({ title, description, variant: 'error', duration: 6000 }),
        ];
      },
    });
  },
  uninstall(pluginId: string) {
    return apiClient.dispatch.uninstallPlugin({
      params: { pluginId },
      onSuccess: () => [removeRow(pluginId), ...pluginsApi.refresh()],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({ title, description, variant: 'error', duration: 5000 }),
        ];
      },
    });
  },
};
