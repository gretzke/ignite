// Top navigation bar: shows app title, connection status, and profile menu
// - Connection status reads from Redux (enum ConnectionStatus)
// - Reconnect button dispatches a store action to trigger middleware reconnection
// - Profile menu fetches server profiles and shows a simple list (no selection wiring yet)
import Tooltip from '../components/Tooltip';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProfileConfig } from '@ignite/api';
import { ConnectionStatus } from '../store/features/connection/connectionSlice';
import { useAppDispatch, useAppSelector } from '../store';
import { reconnectRequested } from '../store/features/connection/connectionSlice';
import { profilesApi } from '../store/features/profiles/profilesSlice';
import Dropdown from '../components/Dropdown';

export default function TopBar() {
  // Redux wiring for connection state and reconnect intent
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.connection.status) as ConnectionStatus;

  // Local UI state for the profile menu popover (used to close on outside click)
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Subscribe to profiles from the store; TopBar is now a passive view
  const serverProfiles = useAppSelector(
    (s) => s.profiles.profiles
  ) as ProfileConfig[];
  const currentServerProfileId = useAppSelector((s) => s.profiles.currentId) as
    | string
    | null;
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
  // Use only server profiles; no local defaults
  const list = (serverProfiles ?? []).slice().sort((a, b) => {
    const ta = a.lastUsed ? Date.parse(a.lastUsed as unknown as string) : 0;
    const tb = b.lastUsed ? Date.parse(b.lastUsed as unknown as string) : 0;
    return tb - ta; // newest first
  });
  const selectedId = currentServerProfileId ?? list[0]?.id;
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
        {status === ConnectionStatus.DISCONNECTED ? (
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
                ? 'CLI: Reconnecting'
                : 'CLI: Disconnected'
            }
            placement="left"
          >
            <span className={`status-dot ${status}`} />
          </Tooltip>
        )}
        <Dropdown
          renderTrigger={({ ref, toggle }) => {
            const isEmpty = serverProfiles.length === 0;
            const button = (
              <button
                type="button"
                ref={ref}
                onClick={isEmpty ? undefined : toggle}
                disabled={isEmpty}
                className={`rounded-full border flex items-center justify-center ${
                  isEmpty ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
                style={{
                  width: 32,
                  height: 32,
                  background: profileColor as string,
                  borderColor: 'color-mix(in oklch, #fff 40%, transparent)',
                }}
                aria-label={isEmpty ? 'No profiles available' : 'Profile menu'}
              >
                <span
                  aria-hidden
                  className="profile-logo"
                  style={{
                    width: 32,
                    height: 32,
                    background: 'transparent',
                    border: 'none',
                  }}
                >
                  <span style={{ fontSize: 14 }}>{current?.icon || ''}</span>
                </span>
              </button>
            );

            return isEmpty ? (
              <Tooltip label="No profiles available">{button}</Tooltip>
            ) : (
              button
            );
          }}
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
                {list.map((p) => {
                  const isCurrent = p.id === currentServerProfileId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={'btn nav-item justify-between btn-secondary'}
                      onClick={() => {
                        if (!isCurrent) {
                          dispatch(profilesApi.switchProfile(p.id));
                        }
                        close();
                      }}
                      style={{ padding: '1rem 1.2rem' }}
                      disabled={isCurrent}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="profile-logo"
                          style={{
                            background: p.color,
                            width: 28,
                            height: 28,
                          }}
                        >
                          <span style={{ fontSize: 14 }}>{p.icon || ''}</span>
                        </span>
                        <span className="nav-label">{p.name}</span>
                      </span>
                      {isCurrent && (
                        <span
                          className="text-xs opacity-75"
                          style={{ fontSize: '0.75rem' }}
                        >
                          Current
                        </span>
                      )}
                    </button>
                  );
                })}
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
