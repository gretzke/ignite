import React, { useEffect } from 'react';
import TopBar from './ui/TopBar';
import Sidebar from './ui/Sidebar';
import { Outlet, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from './store';
import { startConnect } from './store/features/connection/connectionSlice';
import { repositoriesApi } from './store/features/repositories/repositoriesApi';
import PermissionApprovalDialog from './components/PermissionApprovalDialog';
import PluginPermissionsModal from './components/PluginPermissionsModal';
import PluginConfigModal from './components/PluginConfigModal';
import { runtimeHost } from './runtime/RuntimeHost';

type CSSVars = React.CSSProperties & { ['--profile-color']?: string };

interface FocusEventTarget {
  addEventListener(type: 'focus' | 'blur', listener: () => void): void;
  removeEventListener(type: 'focus' | 'blur', listener: () => void): void;
}

// Kept outside App so the focus lifecycle remains small and directly testable.
// The interval exists only while the window is focused, and entering focus
// gets an immediate poll instead of waiting for the first interval tick.
export function startFocusGatedRepoPoll(
  checkRepos: () => void,
  target: FocusEventTarget = window,
  isFocused: () => boolean = () => document.hasFocus()
): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (interval) return;
    checkRepos();
    interval = setInterval(checkRepos, 5_000);
  };
  const stop = () => {
    if (!interval) return;
    clearInterval(interval);
    interval = undefined;
  };
  target.addEventListener('focus', start);
  target.addEventListener('blur', stop);
  if (isFocused()) start();
  return () => {
    stop();
    target.removeEventListener('focus', start);
    target.removeEventListener('blur', stop);
  };
}

export default function App() {
  // Read current theme from Redux and provide an explicit dispatcher
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.app.theme);
  const darkMode = theme === 'dark';
  // Single Redux flag controls both animations and shapes
  const showDetails = useAppSelector((s) => s.app.showDetails);
  const colorHex = useAppSelector((s) => s.app.colorHex);
  const sidebarCollapsed = useAppSelector((s) => s.app.sidebarCollapsed);
  const location = useLocation();
  const versionScopedRoute = location.pathname.startsWith('/repositories/') &&
    new URLSearchParams(location.search).has('version');
  // Connection state used inside TopBar via its own selectors

  const themeClass = darkMode ? 'theme-dark' : 'theme-light';

  // Reflect theme on <html> so portalled elements (tooltips) inherit tokens
  useEffect(() => {
    const rootEl = document.documentElement;
    rootEl.classList.toggle('theme-dark', darkMode);
    rootEl.classList.toggle('theme-light', !darkMode);
  }, [darkMode]);

  // Reflect profile color on <html> so portalled elements (dialogs/tooltips) inherit it
  useEffect(() => {
    const rootEl = document.documentElement;
    rootEl.style.setProperty('--profile-color', colorHex);
  }, [colorHex]);

  // Kick off connection once on mount; middleware manages lifecycle
  useEffect(() => {
    dispatch(startConnect());
  }, [dispatch]);

  useEffect(() => {
    runtimeHost.load().catch((error) => {
      console.warn('Failed to bootstrap frontend runtime host', error);
    });
  }, []);

  // Poll for fingerprint drift while the tab is focused. The backend applies
  // quiet-pause debounce and per-repo cooldown before starting recompiles.
  useEffect(() => {
    if (versionScopedRoute) return;
    return startFocusGatedRepoPoll(() => {
      dispatch(repositoriesApi.checkRepos());
    });
  }, [dispatch, versionScopedRoute]);

  return (
    <div
      className={themeClass}
      data-anim={showDetails ? 'on' : 'off'}
      data-shapes={showDetails ? 'on' : 'off'}
      style={
        {
          backgroundColor: 'var(--bg-base)',
          minHeight: '100vh',
          ['--profile-color']: colorHex,
        } as CSSVars
      }
    >
      {/* Floating top bar */}
      <TopBar />

      {/* Sidebar */}
      <Sidebar />

      {/* Plugin permission approval prompt */}
      <PermissionApprovalDialog />

      {/* Plugin permission request/management modal */}
      <PluginPermissionsModal />

      {/* Plugin config form modal */}
      <PluginConfigModal />

      {/* Ambient background layers */}
      <div className="ambient-gradient" aria-hidden="true" />
      <div className="ambient-shapes" aria-hidden="true">
        <div data-blob="a" />
        <div data-blob="b" />
        <div data-blob="c" />
      </div>

      {/* Main view card fills remaining space */}
      <div
        className="p-0 glass-surface glass-main overflow-y-scroll overflow-x-hidden"
        style={{ left: sidebarCollapsed ? 56 + 24 : 220 + 24 }}
      >
        <div className="m-4">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
