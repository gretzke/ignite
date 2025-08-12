import Tooltip from '../components/Tooltip';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import * as IgniteApiClient from '@ignite/api/client';

type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

interface TopBarProps {
  status: ConnectionStatus;
  attemptsLeft: number;
  maxAttempts: number;
  onReconnect: () => void;
  profiles?: { id: string; name: string; color: string }[];
  currentProfileId?: string;
  onSelectProfile?: (id: string) => void;
}

export default function TopBar({
  status,
  attemptsLeft,
  maxAttempts,
  onReconnect,
  profiles = [],
  currentProfileId,
  onSelectProfile,
}: TopBarProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [serverProfiles, setServerProfiles] = useState<string[] | null>(null);
  const [currentServerProfile, setCurrentServerProfile] = useState<
    string | null
  >(null);
  const [menuCoords, setMenuCoords] = useState<{
    top: number;
    right: number;
  } | null>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (anchorRef.current && anchorRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setMenuCoords({
        top: Math.round(rect.bottom + 8),
        right: Math.round(window.innerWidth - rect.right),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  // Fetch profiles from API
  const api = useMemo(
    () => (IgniteApiClient as any).createClient({ baseUrl: '' }),
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
      } catch {}
      try {
        const cur = await api.request('getCurrentProfile', {});
        if (!cancelled && 'data' in cur) {
          setCurrentServerProfile(cur.data.name);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);
  const defaultProfiles = [
    { id: 'default', name: 'Default', color: 'var(--profile-color)' },
    { id: 'work', name: 'Work', color: '#0ea5e9' },
    { id: 'personal', name: 'Personal', color: '#a78bfa' },
  ];
  const mergedProfiles = (serverProfiles ?? []).map((name) => ({
    id: name,
    name,
    color: 'var(--profile-color)',
  }));
  const list = mergedProfiles.length
    ? mergedProfiles
    : profiles.length
    ? profiles
    : defaultProfiles;
  const selectedId = currentServerProfile ?? currentProfileId;
  const current = list.find((p) => p.id === selectedId) ?? list[0];
  const profileColor = current?.color ?? 'var(--profile-color)';
  return (
    <div className="glass-surface glass-topbar">
      <div className="flex items-center gap-2">
        <span aria-hidden>🚀</span>
        <span className="font-semibold">Ignite</span>
      </div>
      <div className="flex items-center gap-3 relative" ref={anchorRef}>
        {status !== 'connected' && attemptsLeft === 0 ? (
          <button
            type="button"
            onClick={onReconnect}
            className="btn btn-primary"
            title="Retry connection"
          >
            Reconnect
          </button>
        ) : (
          <Tooltip
            label={
              status === 'connected'
                ? 'CLI: Connected'
                : status === 'connecting'
                ? 'CLI: Connecting…'
                : status === 'reconnecting'
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
        <button
          type="button"
          ref={buttonRef}
          onClick={() => setOpen((v) => !v)}
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
        {open &&
          menuCoords &&
          createPortal(
            <div
              ref={menuRef}
              className="tooltip-content"
              style={{
                position: 'fixed',
                top: menuCoords.top,
                right: menuCoords.right,
                padding: 12,
                minWidth: 240,
                background:
                  'color-mix(in oklch, var(--bg-base) calc(var(--glass-milk) + 20%), transparent)',
                borderColor: 'color-mix(in oklch, #fff 28%, transparent)',
              }}
            >
              <div className="text-xs opacity-60 px-2 pb-1">Profiles</div>
              <div className="flex flex-col gap-3">
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="btn btn-secondary nav-item justify-between"
                    onClick={() => {
                      onSelectProfile?.(p.id);
                      setOpen(false);
                    }}
                    style={{
                      padding: '1rem 1.2rem',
                    }}
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
                          {p.id === 'work'
                            ? '💼'
                            : p.id === 'personal'
                            ? '🙂'
                            : '👤'}
                        </span>
                      </span>
                      <span className="nav-label">{p.name}</span>
                    </span>
                    {p.id === currentProfileId && (
                      <span className="text-[10px] opacity-70">current</span>
                    )}
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
                to="/settings"
                onClick={() => setOpen(false)}
                className="btn btn-secondary nav-item nav-item-center btn-block"
                style={{
                  padding: '1rem 1.2rem',
                }}
              >
                Manage profiles
              </Link>
            </div>,
            document.body
          )}
      </div>
    </div>
  );
}
