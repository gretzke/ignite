import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  pluginsApi,
  selectPluginRows,
  selectPluginsLoading,
} from '../store/features/plugins/pluginsSlice';

export default function PluginsPage() {
  const dispatch = useAppDispatch();
  const rows = useAppSelector(selectPluginRows);
  const loading = useAppSelector(selectPluginsLoading);
  const [contextDir, setContextDir] = useState('');
  const [dockerfile, setDockerfile] = useState('');

  useEffect(() => {
    pluginsApi.refresh().forEach((a) => dispatch(a));
  }, [dispatch]);

  const toggle = (
    pluginId: string,
    trust: 'native' | 'trusted' | 'untrusted',
    perms: { hostWrite: boolean; net: boolean },
    key: 'hostWrite' | 'net'
  ) => {
    if (trust === 'native') return;
    const next = { ...perms, [key]: !perms[key] };
    const anyOn = next.hostWrite || next.net;
    dispatch(
      pluginsApi.setPermissions(pluginId, anyOn ? 'trusted' : 'untrusted', next)
    );
  };

  return (
    <div className="text-[var(--text)]">
      <h2 className="page-title">Plugins</h2>

      <div className="flex gap-2 my-4">
        <input
          type="text"
          className="input-glass"
          placeholder="Build context dir (e.g. /path/to/plugins)"
          value={contextDir}
          onChange={(e) => setContextDir(e.target.value)}
        />
        <input
          type="text"
          className="input-glass"
          placeholder="Dockerfile (optional, default: Dockerfile)"
          value={dockerfile}
          onChange={(e) => setDockerfile(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!contextDir.trim()}
          onClick={() => {
            dispatch(
              pluginsApi.install(
                contextDir.trim(),
                dockerfile.trim() || undefined
              )
            );
            setContextDir('');
            setDockerfile('');
          }}
        >
          Install
        </button>
      </div>

      {loading && <p className="opacity-80">Loading…</p>}

      <table className="w-full text-left">
        <thead>
          <tr className="opacity-70">
            <th>Plugin</th>
            <th>Type</th>
            <th>Trust</th>
            <th>hostWrite</th>
            <th>net</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pluginId}>
              <td>{r.name ?? r.pluginId}</td>
              <td>{r.type ?? '—'}</td>
              <td>{r.trust}</td>
              <td>
                <input
                  type="checkbox"
                  checked={r.permissions.hostWrite}
                  disabled={r.trust === 'native'}
                  onChange={() =>
                    toggle(r.pluginId, r.trust, r.permissions, 'hostWrite')
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={r.permissions.net}
                  disabled={r.trust === 'native'}
                  onChange={() =>
                    toggle(r.pluginId, r.trust, r.permissions, 'net')
                  }
                />
              </td>
              <td>
                {r.trust !== 'native' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => dispatch(pluginsApi.uninstall(r.pluginId))}
                  >
                    Uninstall
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
