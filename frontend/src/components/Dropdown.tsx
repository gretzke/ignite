import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Generic dropdown/popover anchored to a trigger element.
// - Positions below the trigger, aligned to its right edge
// - Closes on outside click, updates position on resize/scroll
// - Suitable for simple menus (profiles) or generic dropdowns
export interface DropdownProps {
  renderTrigger: (args: {
    ref: React.MutableRefObject<HTMLElement | null>;
    open: boolean;
    toggle: () => void;
    setOpen: (v: boolean) => void;
  }) => React.ReactNode;
  children:
    | React.ReactNode
    | ((args: { close: () => void }) => React.ReactNode);
  offset?: number; // px between trigger and menu (default 8)
  portal?: boolean; // render in a portal (default true)
  menuClassName?: string;
  menuStyle?: React.CSSProperties; // extra styles merged into positioned container
}

export default function Dropdown({
  renderTrigger,
  children,
  offset = 8,
  portal = true,
  menuClassName,
  menuStyle,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null
  );

  // Toggle helper
  const toggle = useMemo(() => () => setOpen((v) => !v), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (triggerRef.current && triggerRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Compute and update position while open
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords({
        top: Math.round(rect.bottom + offset),
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
  }, [open, offset]);

  const content = (
    <div
      ref={menuRef}
      className={menuClassName}
      style={{
        position: 'fixed',
        top: coords?.top,
        right: coords?.right,
        ...menuStyle,
      }}
    >
      {typeof children === 'function'
        ? (children as (args: { close: () => void }) => React.ReactNode)({
            close: () => setOpen(false),
          })
        : children}
    </div>
  );

  return (
    <>
      {renderTrigger({ ref: triggerRef, open, toggle, setOpen })}
      {open && (portal ? createPortal(content, document.body) : content)}
    </>
  );
}
