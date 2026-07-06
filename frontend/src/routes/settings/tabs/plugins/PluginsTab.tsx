import { useEffect, useMemo, useState } from 'react';
import {
  Folder,
  GitBranch,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import Dropdown from '../../../../components/Dropdown';
import Tooltip from '../../../../components/Tooltip';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import { useAppDispatch, useAppSelector } from '../../../../store';
import {
  openPermissionsModal,
  pluginsApi,
  selectDevMode,
  selectPluginRows,
  selectPluginsLoading,
  type PluginRow,
} from '../../../../store/features/plugins/pluginsSlice';
import {
  InstallFromGitModal,
  InstallFromPathModal,
} from './InstallPluginModal';

const PERMISSION_TITLES: Record<string, string> = {
  hostWrite: 'Host Write',
  net: 'Network',
};

function PluginCard({
  plugin,
  onUninstall,
}: {
  plugin: PluginRow;
  onUninstall?: (plugin: PluginRow) => void;
}) {
  const dispatch = useAppDispatch();
  const isNative = plugin.trust === 'native';
  const granted = (['hostWrite', 'net'] as const).filter(
    (p) => plugin.permissions[p]
  );

  return (
    <div
      className="glass-surface nav-item flex items-center justify-between"
      style={{ padding: '0.9rem 1.1rem' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-8 rounded-[var(--radius)] border border-[var(--profile-color)]/20 bg-[var(--profile-color)]/10 backdrop-blur-sm flex items-center justify-center shrink-0">
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
            {isNative && (
              <span className="text-xs rounded-full pill px-2 py-0.5 shrink-0">
                Built-in
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
          </div>
          {plugin.version && (
            <div className="text-xs opacity-70 truncate">
              v{plugin.version}
            </div>
          )}
        </div>
      </div>
      {!isNative && (
        <div className="flex items-center gap-2 shrink-0">
          <Tooltip label="Manage permissions" placement="top">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Manage permissions"
              onClick={() =>
                dispatch(
                  openPermissionsModal({
                    pluginId: plugin.pluginId,
                    newPermissionIds: [],
                  })
                )
              }
            >
              <ShieldCheck size={14} />
            </button>
          </Tooltip>
          <Tooltip
            label="Update plugin (rebuild from its install source)"
            placement="top"
          >
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Update plugin"
              onClick={() => dispatch(pluginsApi.update(plugin.pluginId))}
            >
              <RefreshCw size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Uninstall plugin" placement="top">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Uninstall plugin"
              onClick={() => onUninstall?.(plugin)}
            >
              <Trash2 size={14} />
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
  const [gitModalOpen, setGitModalOpen] = useState(false);
  const [pathModalOpen, setPathModalOpen] = useState(false);
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

  const addButton = (
    <button
      type="button"
      className="btn btn-primary"
      style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
      aria-label="Install plugin"
      title="Install plugin"
      onClick={() => setGitModalOpen(true)}
    >
      <Plus size={16} />
    </button>
  );

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm opacity-70">Third-Party</div>
        {devMode ? (
          <Dropdown
            renderTrigger={({ ref, toggle }) => (
              <button
                ref={ref}
                type="button"
                className="btn btn-primary"
                style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
                aria-label="Install plugin"
                title="Install plugin"
                onClick={toggle}
              >
                <Plus size={16} />
              </button>
            )}
            menuClassName="tooltip-content"
            menuStyle={{
              padding: 12,
              minWidth: 180,
              background:
                'color-mix(in oklch, var(--bg-base) calc(var(--glass-milk) + 20%), transparent)',
              borderColor: 'color-mix(in oklch, #fff 28%, transparent)',
            }}
          >
            {({ close }) => (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
                  onClick={() => {
                    setGitModalOpen(true);
                    close();
                  }}
                >
                  <GitBranch size={16} />
                  From GitHub
                </button>
                <button
                  type="button"
                  className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
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

      <div className="grid gap-2">
        {thirdParty.length === 0 ? (
          <div className="card-milky p-4">
            <div className="text-sm opacity-70">
              {loading
                ? 'Loading plugins…'
                : 'No third-party plugins installed. Use the + button to install one from GitHub.'}
            </div>
          </div>
        ) : (
          thirdParty.map((p) => (
            <PluginCard
              key={p.pluginId}
              plugin={p}
              onUninstall={handleUninstall}
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

      <InstallFromGitModal open={gitModalOpen} onOpenChange={setGitModalOpen} />
      {devMode && (
        <InstallFromPathModal
          open={pathModalOpen}
          onOpenChange={setPathModalOpen}
        />
      )}

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
