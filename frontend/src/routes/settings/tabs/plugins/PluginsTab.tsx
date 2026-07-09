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
  repoWrite: 'Repo Write',
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
  const granted = (['repoWrite', 'net'] as const).filter(
    (p) => plugin.permissions[p]
  );
  // Granted secret/file config scopes, rendered as unified category pills.
  // Native plugins have every declared scope implicitly granted; third-party
  // pills reflect the actual grant. We group FILE and SECRET fields into
  // single pills per category, with tooltips listing the specific field labels.
  const scopeFields = (plugin.configFields ?? []).filter(
    (f) => f.secret || f.type === 'file'
  );
  const grantedScopes = isNative
    ? scopeFields.map((f) => f.key)
    : plugin.permissions.secrets;

  // Group granted scopes by type: FILE (type === 'file') and SECRET (secret === true)
  const grantedFileFields = grantedScopes
    .map((key) => scopeFields.find((f) => f.key === key))
    .filter((f): f is typeof scopeFields[0] => f !== undefined && f.type === 'file');
  const grantedSecretFields = grantedScopes
    .map((key) => scopeFields.find((f) => f.key === key))
    .filter((f): f is typeof scopeFields[0] => f !== undefined && !!f.secret);

  const manageable = !isNative && versionInfo?.source === 'git';
  const updateAvailable = !isNative && versionInfo?.updateAvailable;
  const hasConfig = Boolean(plugin.configFields?.length);

  const openConfig = () =>
    dispatch(openConfigModal({ pluginId: plugin.pluginId }));

  // Single-action click rule: when a card exposes exactly one action, clicking
  // anywhere on the card triggers it; with two or more actions the card body
  // is inert and only the buttons act. Non-native cards always render Manage
  // permissions + Uninstall (2+ actions), so the only single-action case is a
  // native plugin with a config form (e.g. Infura/Alchemy → Configure). The
  // old whole-card git-manage click always coexisted with other buttons and is
  // replaced by an explicit Manage source button below.
  const cardAction = isNative && hasConfig ? openConfig : undefined;

  const cardClass = 'glass-surface nav-item flex items-center justify-between';
  const cardStyle = { padding: '0.9rem 1.1rem' };

  const body = (
    <>
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
            {plugin.types[0] && (
              <span className="text-xs rounded-full pill px-2 py-0.5 shrink-0 capitalize">
                {plugin.types[0]}
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
            {grantedFileFields.length > 0 && (
              <Tooltip
                label={grantedFileFields.map((f) => f.label).join(', ')}
                placement="top"
              >
                <span className="text-xs rounded-full pill pill-primary px-2 py-0.5 shrink-0 cursor-help">
                  File Read
                </span>
              </Tooltip>
            )}
            {grantedSecretFields.length > 0 && (
              <Tooltip
                label={grantedSecretFields.map((f) => f.label).join(', ')}
                placement="top"
              >
                <span className="text-xs rounded-full pill pill-primary px-2 py-0.5 shrink-0 cursor-help">
                  Secrets
                </span>
              </Tooltip>
            )}
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
                  openConfig();
                }}
              >
                <Settings2 size={14} />
              </button>
            </Tooltip>
          )}
          {manageable && versionInfo && (
            <Tooltip label="Manage source" placement="top">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ width: 32, height: 32, padding: 0 }}
                aria-label="Manage source"
                onClick={(e) => {
                  e.stopPropagation();
                  onManage?.(plugin, versionInfo);
                }}
              >
                <GitBranch size={14} />
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
                openConfig();
              }}
            >
              <Settings2 size={14} />
            </button>
          </Tooltip>
        </div>
      )}
    </>
  );

  if (cardAction) {
    return (
      <div
        className={`${cardClass} cursor-pointer`}
        style={cardStyle}
        role="button"
        tabIndex={0}
        aria-label={`Configure ${plugin.name ?? plugin.pluginId}`}
        onClick={cardAction}
        onKeyDown={(e) => {
          if (
            (e.key === 'Enter' || e.key === ' ') &&
            e.target === e.currentTarget
          ) {
            e.preventDefault();
            cardAction();
          }
        }}
      >
        {body}
      </div>
    );
  }
  return (
    <div className={cardClass} style={cardStyle}>
      {body}
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
