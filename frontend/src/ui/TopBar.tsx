// Top navigation bar: shows app title, connection status, and profile menu
// - Connection status reads from Redux (enum ConnectionStatus)
// - Reconnect button dispatches a store action to trigger middleware reconnection
// - Profile menu fetches server profiles and shows a simple list (no selection wiring yet)
import Tooltip from '../components/Tooltip';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as IgniteApiClient from '@ignite/api/client';
import { ConnectionStatus } from '../store/features/connection/connectionSlice';
import { useAppDispatch, useAppSelector } from '../store';
import { reconnectRequested } from '../store/features/connection/connectionSlice';
import Dropdown from '../components/Dropdown';

export default function TopBar() {
  // Redux wiring for connection state and reconnect intent
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.connection.status) as ConnectionStatus;
  const attemptsLeft = useAppSelector((s) => s.connection.attemptsLeft);
  const maxAttempts = useAppSelector((s) => s.connection.maxAttempts);

  // Local UI state for the profile menu popover (used to close on outside click)
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [serverProfiles, setServerProfiles] = useState<string[] | null>(null);
  const [currentServerProfile, setCurrentServerProfile] = useState<
    string | null
  >(null);
  // Close the profile menu when clicking outside
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (anchorRef.current && anchorRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Dropdown handles its own positioning; no tracking logic needed here
  // Fetch profiles from API (simple demo: list and current name)
  const api = useMemo(
    () =>
      (
        IgniteApiClient as unknown as {
          createClient: (o: { baseUrl: string }) => any;
        }
      ).createClient({ baseUrl: '' }),
    []
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.request('listProfiles', {});
        if (!cancelled && 'data' in list) {
          setServerProfiles(list.data.profiles);
        }
      } catch {
        // ignore profile list errors in the top bar
      }
      try {
        const cur = await api.request('getCurrentProfile', {});
        if (!cancelled && 'data' in cur) {
          setCurrentServerProfile(cur.data.name);
        }
      } catch {
        // ignore current profile errors in the top bar
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);
  // Use only server profiles; no local defaults
  const list = (serverProfiles ?? []).map((name) => ({
    id: name,
    name,
    color: 'var(--profile-color)',
  }));
  const selectedId = currentServerProfile ?? list[0]?.id;
  const current = selectedId
    ? list.find((p) => p.id === selectedId) ?? list[0]
    : undefined;
  const profileColor = current?.color ?? 'var(--profile-color)';
  return (
    <div className="glass-surface glass-topbar">
      <div className="flex items-center gap-2">
        <span aria-hidden>🚀</span>
        <span className="font-semibold">Ignite</span>
      </div>
      <div className="flex items-center gap-3 relative" ref={anchorRef}>
        {status !== ConnectionStatus.CONNECTED && attemptsLeft === 0 ? (
          <button
            type="button"
            onClick={() => dispatch(reconnectRequested())}
            className="btn btn-primary"
            title="Retry connection"
          >
            Reconnect
          </button>
        ) : (
          <Tooltip
            label={
              status === ConnectionStatus.CONNECTED
                ? 'CLI: Connected'
                : status === ConnectionStatus.RECONNECTING
                ? `CLI: Reconnecting… (${
                    maxAttempts - attemptsLeft
                  }/${maxAttempts})`
                : 'CLI: Disconnected'
            }
            placement="left"
          >
            <span className={`status-dot ${status}`} />
          </Tooltip>
        )}
        <Dropdown
          renderTrigger={({ ref, toggle }) => (
            <button
              type="button"
              ref={ref as React.MutableRefObject<HTMLButtonElement | null>}
              onClick={toggle}
              className="rounded-full border cursor-pointer flex items-center justify-center"
              style={{
                width: 32,
                height: 32,
                background: profileColor as string,
                borderColor: 'color-mix(in oklch, #fff 40%, transparent)',
              }}
              aria-label="Profile menu"
            >
              <span aria-hidden>👤</span>
            </button>
          )}
          menuClassName="tooltip-content"
          menuStyle={{
            padding: 12,
            minWidth: 240,
            background:
              'color-mix(in oklch, var(--bg-base) calc(var(--glass-milk) + 20%), transparent)',
            borderColor: 'color-mix(in oklch, #fff 28%, transparent)',
          }}
        >
          {({ close }) => (
            <div>
              <div className="text-xs opacity-60 px-2 pb-1">Profiles</div>
              <div className="flex flex-col gap-3">
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="btn btn-secondary nav-item justify-between"
                    onClick={() => {
                      close();
                    }}
                    style={{ padding: '1rem 1.2rem' }}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        style={{
                          background: p.color,
                          width: 28,
                          height: 28,
                          borderRadius: 9999,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: '1px solid rgba(255,255,255,0.4)',
                        }}
                      >
                        <span style={{ fontSize: 14 }}>
                          {/* TODO: remove and load profile icon */}
                          {p.id === 'work'
                            ? '💼'
                            : p.id === 'personal'
                            ? '🙂'
                            : '👤'}
                        </span>
                      </span>
                      <span className="nav-label">{p.name}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div
                className="h-px my-2"
                style={{
                  background:
                    'color-mix(in oklch, var(--text) 18%, transparent)',
                }}
              />
              <Link
                to="/settings#profiles"
                onClick={() => close()}
                className="btn btn-secondary nav-item nav-item-center btn-block"
                style={{ padding: '1rem 1.2rem' }}
              >
                Manage profiles
              </Link>
            </div>
          )}
        </Dropdown>
      </div>
    </div>
  );
}
