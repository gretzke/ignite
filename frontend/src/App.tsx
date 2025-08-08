import React, { useEffect, useRef, useState } from 'react';
import TopBar from './ui/TopBar';
import Sidebar from './ui/Sidebar';
import { Outlet } from 'react-router-dom';

const COLOR_SWATCHES = [
  '#0d6efd', // blue-500
  '#6610f2', // indigo-500
  '#6f42c1', // purple-500
  '#0dcaf0', // cyan-500
  '#20c997', // teal-500
  '#FF007A', // uniswap-pink
  '#ffc107', // yellow-500
  '#fd7e14', // orange-500
  '#dc3545', // red-500
] as const;

type CSSVars = React.CSSProperties & { ['--profile-color']?: string };

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('ignite:theme') === 'dark';
    } catch {
      return false;
    }
  });
  const [animOn, setAnimOn] = useState(true);
  const [shapesOn, setShapesOn] = useState(true);
  const [color, setColor] = useState<string>('#ec4899');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem('ignite:sidebar-collapsed');
      return v === '1';
    } catch {
      return false;
    }
  });
  const [status, setStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  >('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 10;
  const [attemptsLeft, setAttemptsLeft] = useState(maxReconnectAttempts);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const themeClass = darkMode ? 'theme-dark' : 'theme-light';

  // Reflect theme on <html> so portalled elements (tooltips) inherit tokens
  useEffect(() => {
    const rootEl = document.documentElement;
    rootEl.classList.toggle('theme-dark', darkMode);
    rootEl.classList.toggle('theme-light', !darkMode);
  }, [darkMode]);

  // Minimal CLI connection indicator (WebSocket to backend on 1301)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const delaysMs = [
      1000, 1000, 1000, 2000, 2000, 5000, 10000, 10000, 30000, 30000,
    ];

    const connect = () => {
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING)
      )
        return;
      setStatus((prev) =>
        prev === 'disconnected' ? 'reconnecting' : 'connecting'
      );
      try {
        ws = new WebSocket('ws://localhost:1301/ws');
        wsRef.current = ws;
        ws.onopen = () => {
          setStatus('connected');
          reconnectAttemptsRef.current = 0;
          setAttemptsLeft(maxReconnectAttempts);
        };
        ws.onclose = () => {
          setStatus('disconnected');
          if (reconnectAttemptsRef.current < maxReconnectAttempts) {
            reconnectAttemptsRef.current += 1;
            const delay =
              delaysMs[
                Math.min(reconnectAttemptsRef.current - 1, delaysMs.length - 1)
              ];
            setStatus('reconnecting');
            setAttemptsLeft(
              maxReconnectAttempts - reconnectAttemptsRef.current
            );
            reconnectTimer = window.setTimeout(connect, delay);
          }
        };
        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
            // ignore
          }
        };
      } catch {
        setStatus('disconnected');
      }
    };

    connect();
    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [reconnectNonce]);

  // Persist theme & sidebar state
  useEffect(() => {
    try {
      window.localStorage.setItem('ignite:theme', darkMode ? 'dark' : 'light');
    } catch {
      // ignore
    }
  }, [darkMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'ignite:sidebar-collapsed',
        sidebarCollapsed ? '1' : '0'
      );
    } catch {
      // ignore
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      const t = window.localStorage.getItem('ignite:theme');
      if (t === 'dark') setDarkMode(true);
      if (t === 'light') setDarkMode(false);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div
      className={themeClass}
      data-anim={animOn ? 'on' : 'off'}
      data-shapes={shapesOn ? 'on' : 'off'}
      style={
        {
          backgroundColor: 'var(--bg-base)',
          minHeight: '100vh',
          ['--profile-color']: color,
        } as CSSVars
      }
    >
      {/* Floating top bar */}
      <TopBar
        status={status}
        attemptsLeft={attemptsLeft}
        maxAttempts={maxReconnectAttempts}
        onReconnect={() => {
          // reset counters and trigger a fresh connection cycle
          reconnectAttemptsRef.current = 0;
          setAttemptsLeft(maxReconnectAttempts);
          setStatus('reconnecting');
          try {
            wsRef.current?.close();
          } catch {
            // ignore
          }
          // bump nonce so the websocket effect restarts immediately
          setReconnectNonce((n) => n + 1);
        }}
      />

      {/* Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((s) => !s)}
      />

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
        <Outlet
          context={{
            color,
            setColor,
            animOn,
            setAnimOn,
            shapesOn,
            setShapesOn,
            darkMode,
            setDarkMode,
            swatches: COLOR_SWATCHES,
          }}
        />
      </div>
    </div>
  );
}
