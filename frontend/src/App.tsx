import React, { useEffect } from 'react';
import TopBar from './ui/TopBar';
import Sidebar from './ui/Sidebar';
import { Outlet } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from './store';
import { startConnect } from './store/features/connection/connectionSlice';

type CSSVars = React.CSSProperties & { ['--profile-color']?: string };

export default function App() {
  // Read current theme from Redux and provide an explicit dispatcher
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.app.theme);
  const darkMode = theme === 'dark';
  // Single Redux flag controls both animations and shapes
  const showDetails = useAppSelector((s) => s.app.showDetails);
  const colorHex = useAppSelector((s) => s.app.colorHex);
  const sidebarCollapsed = useAppSelector((s) => s.app.sidebarCollapsed);
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

      {/* Ambient background layers */}
      <div className="ambient-gradient" aria-hidden="true" />
      <div className="ambient-shapes" aria-hidden="true">
        <div data-blob="a" />
        <div data-blob="b" />
        <div data-blob="c" />
      </div>

      {/* Main view card fills remaining space */}
      <div
        className="glass-surface glass-main"
        style={{ left: sidebarCollapsed ? 56 + 24 : 220 + 24 }}
      >
        <Outlet />
      </div>
    </div>
  );
}
