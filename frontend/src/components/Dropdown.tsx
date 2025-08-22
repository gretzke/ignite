import React, { useMemo, useState } from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  size,
} from '@floating-ui/react';

// Generic dropdown/popover anchored to a trigger element using Floating UI.
// - Uses sophisticated positioning with flip, shift, and size constraints
// - Closes on outside click, auto-updates position on resize/scroll
// - Suitable for simple menus (profiles) or generic dropdowns
export interface DropdownProps {
  renderTrigger: (args: {
    ref: (node: HTMLElement | null) => void;
    open: boolean;
    toggle: () => void;
    setOpen: (v: boolean) => void;
    getReferenceProps: () => Record<string, unknown>;
  }) => React.ReactNode;
  children:
    | React.ReactNode
    | ((args: { close: () => void }) => React.ReactNode);
  sideOffset?: number; // px between trigger and menu (default 8)
  portal?: boolean; // render in a portal (default true)
  anchor?: 'left' | 'right'; // anchor position (default: 'right')
  menuClassName?: string;
  menuStyle?: React.CSSProperties; // extra styles merged into positioned container
}

export default function Dropdown({
  renderTrigger,
  children,
  sideOffset = 8,
  portal = true,
  anchor = 'right',
  menuClassName,
  menuStyle,
}: DropdownProps) {
  const [open, setOpen] = useState(false);

  // Toggle helper
  const toggle = useMemo(() => () => setOpen((v) => !v), []);

  // Floating UI setup
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: anchor === 'left' ? 'bottom-start' : 'bottom-end',
    middleware: [
      offset(sideOffset),
      flip({
        fallbackPlacements:
          anchor === 'left'
            ? ['bottom-end', 'top-start', 'top-end']
            : ['bottom-start', 'top-end', 'top-start'],
      }),
      shift({ padding: 6 }),
      size({
        apply({ availableHeight, elements }) {
          // Constrain height to available space
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(200, availableHeight - 20)}px`,
          });
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Interaction hooks (excluding click since we handle it manually)
  const dismiss = useDismiss(context);
  const role = useRole(context);

  const { getReferenceProps, getFloatingProps } = useInteractions([
    dismiss,
    role,
  ]);

  const content = (
    <div
      ref={refs.setFloating}
      className={menuClassName}
      style={{
        ...floatingStyles,
        ...menuStyle,
      }}
      {...getFloatingProps()}
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
      {renderTrigger({
        ref: refs.setReference,
        open,
        toggle,
        setOpen,
        getReferenceProps,
      })}
      {open && (portal ? <FloatingPortal>{content}</FloatingPortal> : content)}
    </>
  );
}
