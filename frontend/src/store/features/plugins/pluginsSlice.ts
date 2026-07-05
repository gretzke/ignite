import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { apiClient } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { formatApiError } from '../../middleware/apiGate';
import type { RootState } from '../../store';

export interface PluginRow {
  pluginId: string;
  name?: string;
  type?: string;
  version?: string;
  trust: 'native' | 'trusted' | 'untrusted';
  permissions: { hostWrite: boolean; net: boolean };
}

interface PluginsState {
  rows: Record<string, PluginRow>;
  loading: boolean;
  devMode: boolean;
}

const initialState: PluginsState = { rows: {}, loading: false, devMode: false };

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
        Record<string, { name: string; type: string; version: string }>
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
        };
      }
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
        };
      }
    },
    removeRow(state, action: PayloadAction<string>) {
      delete state.rows[action.payload];
    },
  },
});

export const { setLoading, setDevMode, setMetadata, setTrust, removeRow } =
  pluginsSlice.actions;
export const selectPluginRows = (s: RootState) =>
  Object.values(s.plugins.rows);
export const selectPluginsLoading = (s: RootState) => s.plugins.loading;
export const selectDevMode = (s: RootState) => s.plugins.devMode;
export const pluginsReducer = pluginsSlice.reducer;

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
                { name: m.name, type: m.type, version: m.version },
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
    ];
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
  install(contextDir: string, dockerfile?: string) {
    return apiClient.dispatch.installPlugin({
      body: {
        source: dockerfile
          ? { kind: 'local', contextDir, dockerfile }
          : { kind: 'local', contextDir },
      },
      onSuccess: () => [
        triggerToast({
          title: 'Plugin installed',
          variant: 'success',
          duration: 3000,
        }),
        ...pluginsApi.refresh(),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return [
          triggerToast({ title, description, variant: 'error', duration: 6000 }),
        ];
      },
    });
  },
  installGit(url: string, ref?: string) {
    return apiClient.dispatch.installPlugin({
      body: { source: ref ? { kind: 'git', url, ref } : { kind: 'git', url } },
      onSuccess: () => [
        triggerToast({
          title: 'Plugin installed',
          variant: 'success',
          duration: 3000,
        }),
        ...pluginsApi.refresh(),
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
