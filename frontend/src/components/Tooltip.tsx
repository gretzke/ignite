import React from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  arrow as floatingArrow,
  autoUpdate,
  useHover,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';

type TooltipProps = {
  label: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactElement;
  sideOffset?: number;
};

export default function Tooltip({
  label,
  placement = 'left',
  children,
  sideOffset = 8,
}: TooltipProps) {
  const arrowRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);

  const {
    refs,
    floatingStyles,
    context,
    middlewareData,
    placement: resolvedPlacement,
  } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(sideOffset),
      flip(),
      shift({ padding: 6 }),
      floatingArrow({ element: arrowRef }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, { move: false, restMs: 0 });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    dismiss,
    role,
  ]);

  const staticSide = {
    top: 'bottom',
    right: 'left',
    bottom: 'top',
    left: 'right',
  }[resolvedPlacement.split('-')[0]] as 'top' | 'right' | 'bottom' | 'left';

  const arrowX = middlewareData.arrow?.x ?? 0;
  const arrowY = middlewareData.arrow?.y ?? 0;

  return (
    <>
      {React.cloneElement(children, {
        ref: refs.setReference,
        ...getReferenceProps(),
      })}
      <FloatingPortal>
        {open && (
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps({ className: 'tooltip-content' })}
          >
            {label}
            <div
              ref={arrowRef}
              className="tooltip-arrow"
              style={
                {
                  position: 'absolute',
                  left:
                    arrowX !== null && arrowX !== undefined
                      ? `${arrowX}px`
                      : '',
                  top:
                    arrowY !== null && arrowY !== undefined
                      ? `${arrowY}px`
                      : '',
                  [staticSide]: '-5px',
                  width: '10px',
                  height: '10px',
                  clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
                } as React.CSSProperties
              }
            />
          </div>
        )}
      </FloatingPortal>
    </>
  );
}
