import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpCircle,
  Folder,
  GitBranch,
  Package,
  Plug,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { PluginVersionInfoData } from '@ignite/api';
import Dropdown from '../../../../components/Dropdown';
import Tooltip from '../../../../components/Tooltip';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import { useAppDispatch, useAppSelector } from '../../../../store';
import {
  openConfigModal,
  openPermissionsModal,
  pluginsApi,
  selectDevMode,
  selectPluginRows,
  selectPluginsLoading,
  selectPluginVersions,
  type PluginRow,
} from '../../../../store/features/plugins/pluginsSlice';
import {
  InstallFromGitModal,
  InstallFromPathModal,
  type ManageTarget,
} from './InstallPluginModal';
import PluginUpdateModal from './PluginUpdateModal';
import PluginStoreModal from './PluginStoreModal';

const PERMISSION_TITLES: Record<string, string> = {
  hostWrite: 'Host Write',
  net: 'Network',
};

function trackSubtitle(
  info: PluginVersionInfoData | undefined,
  manifestVersion?: string
): string {
  if (!info || info.source !== 'git') return '';
  if (info.track === 'release' && info.trackRef) {
    // Skip when the tracked tag just repeats the manifest version.
    return info.trackRef.replace(/^v/, '') === manifestVersion
      ? ''
      : ` · ${info.trackRef}`;
  }
  if (info.track === 'branch' && info.trackRef) {
    return ` · ${info.trackRef}${
      info.currentCommit ? ` @ ${info.currentCommit.slice(0, 7)}` : ''
    }`;
  }
  if (info.track === 'commit' && info.currentCommit) {
    return ` · pinned @ ${info.currentCommit.slice(0, 7)}`;
  }
  return '';
}

function PluginCard({
  plugin,
  versionInfo,
  onUninstall,
  onManage,
  onUpdate,
}: {
  plugin: PluginRow;
  versionInfo?: PluginVersionInfoData;
  onUninstall?: (plugin: PluginRow) => void;
  onManage?: (plugin: PluginRow, info: PluginVersionInfoData) => void;
  onUpdate?: (plugin: PluginRow, info: PluginVersionInfoData) => void;
}) {
  const dispatch = useAppDispatch();
  const isNative = plugin.trust === 'native';
  const granted = (['hostWrite', 'net'] as const).filter(
    (p) => plugin.permissions[p]
  );
  const manageable = !isNative && versionInfo?.source === 'git';
  const updateAvailable = !isNative && versionInfo?.updateAvailable;
  const hasConfig = Boolean(plugin.configFields?.length);

  const handleManage = () => {
    if (manageable && versionInfo && onManage) onManage(plugin, versionInfo);
  };

  return (
    <div
      className={`glass-surface nav-item flex items-center justify-between ${
        manageable ? 'cursor-pointer' : ''
      }`}
      style={{ padding: '0.9rem 1.1rem' }}
      role={manageable ? 'button' : undefined}
      tabIndex={manageable ? 0 : undefined}
      onClick={handleManage}
      onKeyDown={(e) => {
        if (manageable && e.key === 'Enter' && e.target === e.currentTarget) {
          handleManage();
        }
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="icon-tile"
          style={{
            background: 'color-mix(in oklch, var(--accent) 12%, transparent)',
            borderColor: 'color-mix(in oklch, var(--accent) 25%, transparent)',
          }}
        >
          <Plug size={16} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">
              {plugin.name ?? plugin.pluginId}
            </span>
            {plugin.type && (
              <span className="text-xs rounded-full pill px-2 py-0.5 shrink-0 capitalize">
                {plugin.type}
              </span>
            )}
            {!isNative &&
              granted.map((p) => (
                <span
                  key={p}
                  className="text-xs rounded-full pill pill-primary px-2 py-0.5 shrink-0"
                >
                  {PERMISSION_TITLES[p]}
                </span>
              ))}
            {updateAvailable && (
              <span className="text-xs rounded-full pill pill-primary px-2 py-0.5 shrink-0">
                Update available
              </span>
            )}
          </div>
          <div className="text-xs opacity-70 truncate">
            {plugin.version ? `v${plugin.version}` : ''}
            {trackSubtitle(versionInfo, plugin.version)}
          </div>
          {versionInfo?.description && (
            <div className="text-xs opacity-60 truncate">
              {versionInfo.description}
            </div>
          )}
        </div>
      </div>
      {!isNative && (
        <div className="flex items-center gap-2 shrink-0">
          {updateAvailable && versionInfo && (
            <Tooltip
              label={
                versionInfo.track === 'release'
                  ? `Update to ${versionInfo.latestVersion}`
                  : 'Update to the latest commit'
              }
              placement="top"
            >
              <button
                type="button"
                className="btn btn-primary btn-sm flex items-center gap-1"
                style={{ height: 32 }}
                aria-label="Update plugin"
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate?.(plugin, versionInfo);
                }}
              >
                <ArrowUpCircle size={14} />
                Update
              </button>
            </Tooltip>
          )}
          {hasConfig && (
            <Tooltip label="Configure" placement="top">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ width: 32, height: 32, padding: 0 }}
                aria-label="Configure"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(openConfigModal({ pluginId: plugin.pluginId }));
                }}
              >
                <Settings2 size={14} />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Manage permissions" placement="top">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Manage permissions"
              onClick={(e) => {
                e.stopPropagation();
                dispatch(
                  openPermissionsModal({
                    pluginId: plugin.pluginId,
                    newPermissionIds: [],
                  })
                );
              }}
            >
              <ShieldCheck size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Uninstall plugin" placement="top">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Uninstall plugin"
              onClick={(e) => {
                e.stopPropagation();
                onUninstall?.(plugin);
              }}
            >
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </div>
      )}
      {isNative && hasConfig && (
        <div className="flex items-center gap-2 shrink-0">
          <Tooltip label="Configure" placement="top">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Configure"
              onClick={(e) => {
                e.stopPropagation();
                dispatch(openConfigModal({ pluginId: plugin.pluginId }));
              }}
            >
              <Settings2 size={14} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

export default function PluginsTab() {
  const dispatch = useAppDispatch();
  const rows = useAppSelector(selectPluginRows);
  const loading = useAppSelector(selectPluginsLoading);
  const devMode = useAppSelector(selectDevMode);
  const versions = useAppSelector(selectPluginVersions);
  const [gitModalOpen, setGitModalOpen] = useState(false);
  const [pathModalOpen, setPathModalOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [prefillUrl, setPrefillUrl] = useState<string | undefined>(undefined);
  const [manageTarget, setManageTarget] = useState<ManageTarget | null>(null);
  const [updateTarget, setUpdateTarget] = useState<{
    name: string;
    info: PluginVersionInfoData;
  } | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [pluginToUninstall, setPluginToUninstall] = useState<PluginRow | null>(
    null
  );
  const [confirmUninstallOpen, setConfirmUninstallOpen] = useState(false);

  useEffect(() => {
    pluginsApi.refresh().forEach((a) => dispatch(a));
  }, [dispatch]);

  const { thirdParty, builtIn } = useMemo(() => {
    const sorted = rows
      .slice()
      .sort((a, b) =>
        (a.name ?? a.pluginId).localeCompare(b.name ?? b.pluginId)
      );
    return {
      thirdParty: sorted.filter((r) => r.trust !== 'native'),
      builtIn: sorted.filter((r) => r.trust === 'native'),
    };
  }, [rows]);

  const handleUninstall = (plugin: PluginRow) => {
    setPluginToUninstall(plugin);
    setConfirmUninstallOpen(true);
  };

  const handleManage = (plugin: PluginRow, info: PluginVersionInfoData) => {
    if (!info.repoUrl) return;
    setManageTarget({
      pluginId: plugin.pluginId,
      name: plugin.name ?? plugin.pluginId,
      url: info.repoUrl,
      currentRef: info.track === 'release' ? info.trackRef : undefined,
    });
    setGitModalOpen(true);
  };

  const handleUpdate = (plugin: PluginRow, info: PluginVersionInfoData) => {
    setUpdateTarget({ name: plugin.name ?? plugin.pluginId, info });
    setUpdateModalOpen(true);
  };

  const openInstall = () => {
    setManageTarget(null);
    setPrefillUrl(undefined);
    setGitModalOpen(true);
  };

  const openInstallWithUrl = (url: string) => {
    setManageTarget(null);
    setPrefillUrl(url);
    setGitModalOpen(true);
  };

  const storeButton = (
    <Tooltip label="Plugin Store" placement="top">
      <button
        type="button"
        className="btn btn-secondary"
        style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
        aria-label="Plugin Store"
        onClick={() => setStoreOpen(true)}
      >
        <Package size={16} />
      </button>
    </Tooltip>
  );

  const addButton = (
    <button
      type="button"
      className="btn btn-primary"
      style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
      aria-label="Install plugin"
      title="Install plugin"
      onClick={openInstall}
    >
      <Plus size={16} />
    </button>
  );

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm opacity-70">Third-Party</div>
        <div className="flex items-center gap-2">
          {storeButton}
          {devMode ? (
            <Dropdown
              renderTrigger={({ ref, toggle }) => (
                <button
                  ref={ref}
                  type="button"
                  className="btn btn-primary"
                  style={{
                    width: 40,
                    height: 36,
                    paddingLeft: 0,
                    paddingRight: 0,
                  }}
                  aria-label="Install plugin"
                  title="Install plugin"
                  onClick={toggle}
                >
                  <Plus size={16} />
                </button>
              )}
              menuClassName="glass-overlay"
              menuStyle={{
                padding: 12,
                minWidth: 180,
              }}
            >
              {({ close }) => (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary flex items-center justify-start gap-2 w-full text-sm"
                    onClick={() => {
                      openInstall();
                      close();
                    }}
                  >
                    <GitBranch size={16} />
                    From GitHub
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary flex items-center justify-start gap-2 w-full text-sm"
                    onClick={() => {
                      setPathModalOpen(true);
                      close();
                    }}
                  >
                    <Folder size={16} />
                    From Local Path
                  </button>
                </div>
              )}
            </Dropdown>
          ) : (
            addButton
          )}
        </div>
      </div>

      <div className="grid gap-2">
        {thirdParty.length === 0 ? (
          <div className="card-milky p-4">
            <div className="text-sm opacity-70">
              {loading
                ? 'Loading plugins…'
                : 'No third-party plugins installed. Use the + button to install one from GitHub, or browse the Plugin Store.'}
            </div>
          </div>
        ) : (
          thirdParty.map((p) => (
            <PluginCard
              key={p.pluginId}
              plugin={p}
              versionInfo={versions[p.pluginId]}
              onUninstall={handleUninstall}
              onManage={handleManage}
              onUpdate={handleUpdate}
            />
          ))
        )}
      </div>

      {builtIn.length > 0 && (
        <div className="mt-6">
          <div className="text-sm opacity-70 mb-2">Built-in</div>
          <div className="grid gap-2">
            {builtIn.map((p) => (
              <PluginCard key={p.pluginId} plugin={p} />
            ))}
          </div>
        </div>
      )}

      <InstallFromGitModal
        open={gitModalOpen}
        onOpenChange={(open) => {
          setGitModalOpen(open);
          if (!open) {
            setManageTarget(null);
            setPrefillUrl(undefined);
          }
        }}
        manage={manageTarget}
        prefillUrl={prefillUrl}
      />
      {devMode && (
        <InstallFromPathModal
          open={pathModalOpen}
          onOpenChange={setPathModalOpen}
        />
      )}
      <PluginStoreModal
        open={storeOpen}
        onOpenChange={setStoreOpen}
        onInstall={openInstallWithUrl}
      />
      <PluginUpdateModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        pluginName={updateTarget?.name ?? ''}
        info={updateTarget?.info ?? null}
      />

      <ConfirmDialog
        open={confirmUninstallOpen}
        onOpenChange={setConfirmUninstallOpen}
        title="Uninstall Plugin"
        description={
          pluginToUninstall ? (
            <>
              Are you sure you want to uninstall{' '}
              <strong>
                {pluginToUninstall.name ?? pluginToUninstall.pluginId}
              </strong>
              ?
            </>
          ) : undefined
        }
        confirmText="Uninstall"
        variant="danger"
        onConfirm={() => {
          if (!pluginToUninstall) return;
          dispatch(pluginsApi.uninstall(pluginToUninstall.pluginId));
        }}
      />
    </div>
  );
}
