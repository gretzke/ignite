import { useState, useMemo, useRef, useEffect } from 'react';
import * as RadixSelect from '@radix-ui/react-select';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';

// TODO:
// Bugs:
// - When the dropdown is open within a modal and the modal is closed using the escape key, the UI is bricked and nothing can be clicked
//   - Unless the modal data is cleaned up on close, this fixes this issue
// - When searching by typing the first item is not highlighted. It can still be selected by pressing enter, this is a purely visual bug. But it's unintuitive, for example pressing the arrow key down the highlight will jump straight to the second item, creating the impression with the user that the first item is skipped.
// - Caused by Radix UI. Potentially rewrite this component from scratch?

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  defaultPriority?: string[]; // Priority order for default selection (e.g., ['main', 'master'])
  disabled?: boolean;
  className?: string;
}

export default function Select({
  options,
  value,
  onValueChange,
  placeholder = 'Select option...',
  defaultPriority = [],
  disabled = false,
  className = '',
}: SelectProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pointerSelectingRef = useRef(false);
  // Show search if more than 10 options
  const showSearch = options.length > 10;
  const [searchFocused, setSearchFocused] = useState(false);

  // Focus the active/selectable Radix item in the list
  const focusActiveRadixItem = () => {
    const root = contentRef.current;
    if (!root) return null;
    const el = (root.querySelector('[data-highlighted]') ||
      root.querySelector('[data-state="checked"]') ||
      root.querySelector('[role="option"]')) as HTMLElement | null;
    el?.focus();
    return el;
  };

  // Keep focus on the search input when opening the menu
  useEffect(() => {
    if (open && showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [open, showSearch]);

  // Hard-guard: while searching, continuously ensure focus stays on the input
  useEffect(() => {
    if (!(open && showSearch && searchFocused)) return;
    let raf = 0 as number;
    const enforce = () => {
      if (
        searchInputRef.current &&
        !pointerSelectingRef.current &&
        document.activeElement !== searchInputRef.current
      ) {
        searchInputRef.current.focus();
      }
      raf = window.requestAnimationFrame(enforce);
    };
    raf = window.requestAnimationFrame(enforce);
    return () => window.cancelAnimationFrame(raf);
  }, [open, showSearch, searchFocused]);

  // Global outside click guard (capture). Ensures cleanup even if parent modal closes first.
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (evt: Event) => {
      const target = evt.target as Node | null;
      const inside = !!(
        target &&
        contentRef.current &&
        contentRef.current.contains(target)
      );
      if (!inside) {
        setOpen(false);
        setSearchFocused(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [open]);

  // Determine default value based on priority
  const defaultValue = useMemo(() => {
    if (value) return value;

    // Find the first option that matches the priority order
    for (const priority of defaultPriority) {
      const match = options.find((option) => option.value === priority);
      if (match) return match.value;
    }

    // Fallback to first option if no priority matches
    return options[0]?.value || '';
  }, [options, defaultPriority, value]);

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        option.value.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [options, searchQuery]);

  // Get display label for selected value
  const selectedOption = options.find(
    (option) => option.value === (value || defaultValue)
  );
  const displayLabel = selectedOption?.label || placeholder;

  return (
    <RadixSelect.Root
      value={value || defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset search state on close to avoid stale focus guards
        if (!next) {
          setSearchQuery('');
        }
      }}
    >
      <RadixSelect.Trigger
        className={`input-glass flex items-center justify-between ${className}`}
        style={{ height: 'auto', minHeight: '42px' }}
      >
        <RadixSelect.Value>
          <span className="truncate">{displayLabel}</span>
        </RadixSelect.Value>
        <RadixSelect.Icon className="ml-2 flex-shrink-0">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          ref={contentRef}
          className="glass-surface"
          style={{
            padding: 0,
            minWidth: 200,
            maxHeight: 320,
            zIndex: 9999,
          }}
          position="popper"
          side="bottom"
          align="end"
          sideOffset={8}
        >
          {/* Search field for large lists */}
          {showSearch && (
            <div className="p-3 border-b border-white/10">
              <div className="relative">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 opacity-50"
                />
                <input
                  type="text"
                  placeholder="Search branches..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input-glass pl-10"
                  autoFocus
                  ref={searchInputRef}
                  onFocus={() => setSearchFocused(true)}
                  onKeyDown={(e) => {
                    const key = e.key;
                    if (
                      key === 'ArrowDown' ||
                      key === 'ArrowUp' ||
                      key === 'Enter'
                    ) {
                      // Hand off to Radix: move focus to an item, then forward the key
                      e.preventDefault();
                      setSearchFocused(false);
                      setTimeout(() => {
                        const target = focusActiveRadixItem();
                        if (target) {
                          const evt = new KeyboardEvent('keydown', {
                            key,
                            bubbles: true,
                            cancelable: true,
                          });
                          target.dispatchEvent(evt);
                        }
                      }, 0);
                    }
                  }}
                />
              </div>
            </div>
          )}

          <RadixSelect.ScrollUpButton className="flex items-center justify-center h-6 cursor-default">
            <ChevronUp size={14} />
          </RadixSelect.ScrollUpButton>

          <RadixSelect.Viewport
            className="p-1"
            style={{ maxHeight: showSearch ? '220px' : '280px' }}
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  className="relative flex items-center px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:bg-white/5 focus:bg-white/5 data-[state=checked]:bg-white/10"
                >
                  <RadixSelect.ItemText>
                    <span className="truncate">{option.label}</span>
                  </RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="absolute right-3">
                    <div className="w-2 h-2 bg-current rounded-full" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))
            ) : (
              <div className="px-3 py-2 text-sm opacity-50 text-center">
                No options found
              </div>
            )}
          </RadixSelect.Viewport>

          <RadixSelect.ScrollDownButton className="flex items-center justify-center h-6 cursor-default">
            <ChevronDown size={14} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
