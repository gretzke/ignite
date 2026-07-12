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
  matchTriggerWidth?: boolean; // menu at least as wide as the trigger
  menuClassName?: string;
  menuStyle?: React.CSSProperties; // extra styles merged into positioned container
}

export default function Dropdown({
  renderTrigger,
  children,
  sideOffset = 8,
  portal = true,
  anchor = 'right',
  matchTriggerWidth = false,
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
        apply({ availableHeight, rects, elements }) {
          // Constrain height to available space
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(0, availableHeight - 12)}px`,
            // A menu narrower than its trigger reads as detached
            ...(matchTriggerWidth
              ? { minWidth: `${rects.reference.width}px` }
              : {}),
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

  // A Radix dialog disables pointer events outside its content. Rooting a
  // portal in the closest dialog keeps its menu interactive while still
  // lifting it above scrollable dialog bodies, where an in-place menu would
  // otherwise be clipped.
  const reference = refs.reference.current;
  const closestDialog =
    reference instanceof Element
      ? reference.closest('[role="dialog"]')
      : undefined;
  const portalRoot =
    closestDialog instanceof HTMLElement ? closestDialog : undefined;

  return (
    <>
      {renderTrigger({
        ref: refs.setReference,
        open,
        toggle,
        setOpen,
        getReferenceProps,
      })}
      {open &&
        (portal ? (
          <FloatingPortal root={portalRoot}>{content}</FloatingPortal>
        ) : (
          content
        ))}
    </>
  );
}
