import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import Dropdown from './Dropdown';

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
  anchor?: 'left' | 'right'; // Dropdown anchor position (default: 'right')
  renderTrigger?: (props: {
    ref: (node: HTMLElement | null) => void;
    open: boolean;
    toggle: () => void;
    displayLabel: string;
    disabled: boolean;
    getReferenceProps?: () => Record<string, unknown>;
  }) => React.ReactNode;
}

export default function Select({
  options,
  value,
  onValueChange,
  placeholder = 'Select option...',
  defaultPriority = [],
  disabled = false,
  className = '',
  anchor = 'right',
  renderTrigger,
}: SelectProps) {
  // Show search if more than 10 options
  const showSearch = options.length > 10;

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

  // Get display label for selected value
  const selectedOption = options.find(
    (option) => option.value === (value || defaultValue)
  );
  const displayLabel = selectedOption?.label || placeholder;

  // Calculate width based on the widest option in the full options list
  const maxOptionWidth = useMemo(() => {
    if (options.length === 0) return 200;

    // Create a temporary element to measure text width
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return 200;

    // Use approximate font settings (matching our CSS)
    context.font = '14px system-ui, sans-serif';

    let maxWidth = 0;
    options.forEach((option) => {
      const width = context.measureText(option.label).width;
      maxWidth = Math.max(maxWidth, width);
    });

    // Add padding (px-3 = 12px each side) + indicator space (right-3 = 12px + 8px for dot)
    return Math.max(200, Math.ceil(maxWidth + 24 + 20));
  }, [options]);

  return (
    <Dropdown
      anchor={anchor}
      sideOffset={8}
      menuClassName="glass-surface"
      menuStyle={{
        padding: 0,
        width: maxOptionWidth,
        maxHeight: 320,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
      }}
      renderTrigger={({ ref, open, toggle, getReferenceProps }) => {
        if (renderTrigger) {
          return renderTrigger({
            ref,
            open,
            toggle,
            displayLabel,
            disabled,
            getReferenceProps,
          });
        }

        // Default trigger if none provided
        return (
          <button
            ref={ref}
            type="button"
            className={`input-glass flex items-center justify-between ${className}`}
            style={{ height: 'auto', minHeight: '42px' }}
            onClick={toggle}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span className="truncate">{displayLabel}</span>
            <div className="ml-2 flex-shrink-0">
              {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </div>
          </button>
        );
      }}
    >
      {({ close }) => (
        <SelectContent
          options={options}
          showSearch={showSearch}
          value={value}
          defaultValue={defaultValue}
          onValueChange={onValueChange}
          close={close}
        />
      )}
    </Dropdown>
  );
}

// Separate component for dropdown content
interface SelectContentProps {
  options: SelectOption[];
  showSearch: boolean;
  value?: string;
  defaultValue: string;
  onValueChange?: (value: string) => void;
  close: () => void;
}

function SelectContent({
  options,
  showSearch,
  value,
  defaultValue,
  onValueChange,
  close,
}: SelectContentProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  // Base viewport height similar to Radix content viewport
  const baseHeight = showSearch ? 220 : 280;
  const ITEM_HEIGHT = 36;

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        option.value.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [options, searchQuery]);

  // Current options to display - filtered if searching, otherwise all
  const currentOptions = showSearch ? filteredOptions : options;

  // Calculate dynamic height based on available items
  const maxVisibleItems = Math.floor(baseHeight / ITEM_HEIGHT);
  const availableItems = currentOptions.length;
  const visibleItems = Math.min(maxVisibleItems, Math.max(1, availableItems)); // At least 1 to show "No options found"
  const dynamicHeight = visibleItems * ITEM_HEIGHT + 8; // Add 8px extra padding to prevent cutoff

  // Handle option selection
  const handleSelect = useCallback(
    (optionValue: string) => {
      onValueChange?.(optionValue);
      close();
    },
    [onValueChange, close]
  );

  // Radix-style scroll functionality
  const updateScrollButtons = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Only show scroll buttons if there are more items than can be displayed
    const hasScrollableContent = availableItems > visibleItems;
    if (!hasScrollableContent) {
      setCanScrollUp(false);
      setCanScrollDown(false);
      return;
    }

    setCanScrollUp(viewport.scrollTop > 0);
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    setCanScrollDown(Math.ceil(viewport.scrollTop) < maxScroll);
  }, [availableItems, visibleItems]);

  // Auto-scroll timer for scroll buttons (Radix-style)
  const autoScrollTimerRef = useRef<number | null>(null);

  const clearAutoScrollTimer = useCallback(() => {
    if (autoScrollTimerRef.current !== null) {
      window.clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  const onAutoScroll = useCallback(
    (direction: 'up' | 'down') => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      // Scroll by one item height like Radix does
      const scrollAmount = direction === 'up' ? -ITEM_HEIGHT : ITEM_HEIGHT;
      viewport.scrollTop = viewport.scrollTop + scrollAmount;
      updateScrollButtons();
    },
    [updateScrollButtons]
  );

  // Start auto-scrolling when hovering/pressing scroll buttons
  const startAutoScroll = useCallback(
    (direction: 'up' | 'down') => {
      if (autoScrollTimerRef.current === null) {
        autoScrollTimerRef.current = window.setInterval(
          () => onAutoScroll(direction),
          50
        );
      }
    },
    [onAutoScroll]
  );

  const stopAutoScroll = useCallback(() => {
    clearAutoScrollTimer();
  }, [clearAutoScrollTimer]);

  // Single step scroll for click events
  const scrollByStep = useCallback(
    (direction: 'up' | 'down') => {
      onAutoScroll(direction);
    },
    [onAutoScroll]
  );

  // Radix-style: Re-scroll active item into view when scroll buttons mount/unmount
  // This ensures the highlighted item stays in view when the viewport height changes
  const handleScrollButtonChange = useCallback(() => {
    if (highlightedIndex >= 0) {
      const activeItem = optionRefs.current[highlightedIndex];
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
        updateScrollButtons();
      }
    }
  }, [highlightedIndex, updateScrollButtons]);

  // Track when scroll buttons mount/unmount to trigger repositioning
  useEffect(() => {
    handleScrollButtonChange();
  }, [canScrollUp, canScrollDown, handleScrollButtonChange]);

  // Radix-style keyboard navigation - focuses items and scrolls viewport
  const focusItem = useCallback(
    (index: number) => {
      const optionElement = optionRefs.current[index];
      const viewport = viewportRef.current;
      if (optionElement && viewport) {
        // Focus the item
        optionElement.focus({ preventScroll: true });
        // Scroll into view with 'nearest' behavior like Radix
        optionElement.scrollIntoView({ block: 'nearest' });
        updateScrollButtons();
      }
    },
    [updateScrollButtons]
  );

  // Handle search input key events with Radix-style navigation
  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex =
          highlightedIndex === -1
            ? 0
            : highlightedIndex < currentOptions.length - 1
            ? highlightedIndex + 1
            : 0;
        setHighlightedIndex(nextIndex);
        focusItem(nextIndex);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prevIndex =
          highlightedIndex === -1
            ? currentOptions.length - 1
            : highlightedIndex > 0
            ? highlightedIndex - 1
            : currentOptions.length - 1;
        setHighlightedIndex(prevIndex);
        focusItem(prevIndex);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setHighlightedIndex(0);
        focusItem(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        const lastIndex = currentOptions.length - 1;
        setHighlightedIndex(lastIndex);
        focusItem(lastIndex);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
          handleSelect(currentOptions[highlightedIndex].value);
        } else if (currentOptions.length > 0) {
          handleSelect(currentOptions[0].value);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    [currentOptions, handleSelect, close, highlightedIndex, focusItem]
  );

  // Radix-style keyboard navigation for the entire dropdown
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Skip if search input is focused
      if (showSearch && document.activeElement === searchInputRef.current) {
        return;
      }

      // Prevent tab navigation within select
      if (event.key === 'Tab') {
        event.preventDefault();
        return;
      }

      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          const nextIndex =
            highlightedIndex < currentOptions.length - 1
              ? highlightedIndex + 1
              : 0;
          setHighlightedIndex(nextIndex);
          // Use setTimeout to prevent React batching issues (like Radix does)
          setTimeout(() => focusItem(nextIndex));
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          const prevIndex =
            highlightedIndex > 0
              ? highlightedIndex - 1
              : currentOptions.length - 1;
          setHighlightedIndex(prevIndex);
          setTimeout(() => focusItem(prevIndex));
          break;
        }
        case 'Home': {
          event.preventDefault();
          setHighlightedIndex(0);
          setTimeout(() => focusItem(0));
          break;
        }
        case 'End': {
          event.preventDefault();
          const lastIndex = currentOptions.length - 1;
          setHighlightedIndex(lastIndex);
          setTimeout(() => focusItem(lastIndex));
          break;
        }
        case 'Enter':
        case ' ':
          event.preventDefault();
          if (highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
            handleSelect(currentOptions[highlightedIndex].value);
          } else if (currentOptions.length > 0) {
            handleSelect(currentOptions[0].value);
          }
          break;
        case 'Escape':
          event.preventDefault();
          close();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    highlightedIndex,
    currentOptions,
    handleSelect,
    close,
    showSearch,
    focusItem,
  ]);

  // Attach scroll listener to update chevrons visibility
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onScroll = () => updateScrollButtons();
    updateScrollButtons();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll as EventListener);
  }, [currentOptions.length, updateScrollButtons]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
      setHighlightedIndex(-1);
    } else {
      setHighlightedIndex(0);
    }
  }, [showSearch]);

  // When search query changes, reset position
  useEffect(() => {
    const node = viewportRef.current;
    if (node) node.scrollTop = 0;
    updateScrollButtons();
    if (showSearch && searchQuery && currentOptions.length > 0) {
      setHighlightedIndex(0);
    }
  }, [searchQuery, showSearch, currentOptions.length, updateScrollButtons]);

  // Update option refs array
  useEffect(() => {
    optionRefs.current = Array(currentOptions.length).fill(null);
  }, [currentOptions.length]);

  // Initialize focus on first item when not searching
  useEffect(() => {
    if (!showSearch && currentOptions.length > 0 && highlightedIndex === -1) {
      setHighlightedIndex(0);
      setTimeout(() => focusItem(0));
    }
  }, [showSearch, currentOptions.length, highlightedIndex, focusItem]);

  // Cleanup auto-scroll timer on unmount
  useEffect(() => {
    return () => {
      clearAutoScrollTimer();
    };
  }, [clearAutoScrollTimer]);

  return (
    <div>
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
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setHighlightedIndex(-1);
              }}
              className="input-glass pl-10 w-full"
              ref={searchInputRef}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
        </div>
      )}

      {/* Radix-style Scroll Up Button */}
      {canScrollUp && (
        <div
          className="flex items-center justify-center h-4 cursor-pointer flex-shrink-0"
          aria-hidden
          onPointerDown={() => startAutoScroll('up')}
          onPointerMove={() => startAutoScroll('up')}
          onPointerLeave={stopAutoScroll}
          onClick={() => scrollByStep('up')}
          style={{ flexShrink: 0 }}
        >
          <ChevronUp size={14} className="opacity-70" />
        </div>
      )}

      {/* Radix-style Viewport - scrollable container */}
      <div
        ref={viewportRef}
        className="p-1 overflow-hidden overflow-y-auto"
        style={{
          position: 'relative',
          flex: 1,
          height: `${
            dynamicHeight - (canScrollUp ? 16 : 0) - (canScrollDown ? 16 : 0)
          }px`,
          // Hide scrollbars like Radix does
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
        role="listbox"
        data-radix-select-viewport=""
      >
        {currentOptions.length > 0 ? (
          currentOptions.map((option, index) => (
            <div
              key={option.value}
              ref={(el) => (optionRefs.current[index] = el)}
              className={`relative flex items-center px-3 py-2 text-sm rounded-lg cursor-pointer outline-none hover:select-option-highlighted ${
                highlightedIndex === index ? 'select-option-highlighted' : ''
              } ${
                (value || defaultValue) === option.value
                  ? 'select-option-selected'
                  : ''
              }`}
              onClick={() => handleSelect(option.value)}
              onMouseEnter={() => setHighlightedIndex(index)}
              onPointerMove={() => {
                // Focus on mouse move like Radix does
                if (highlightedIndex !== index) {
                  setHighlightedIndex(index);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(option.value);
                }
              }}
              role="option"
              aria-selected={(value || defaultValue) === option.value}
              tabIndex={-1}
            >
              <span className="truncate">{option.label}</span>
              {(value || defaultValue) === option.value && (
                <div className="absolute right-3">
                  <div className="w-2 h-2 bg-current rounded-full" />
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-sm opacity-50 text-center">
            No options found
          </div>
        )}
      </div>

      {/* Radix-style Scroll Down Button */}
      {canScrollDown && (
        <div
          className="flex items-center justify-center h-4 cursor-pointer flex-shrink-0"
          aria-hidden
          onPointerDown={() => startAutoScroll('down')}
          onPointerMove={() => startAutoScroll('down')}
          onPointerLeave={stopAutoScroll}
          onClick={() => scrollByStep('down')}
          style={{ flexShrink: 0 }}
        >
          <ChevronDown size={14} className="opacity-70" />
        </div>
      )}
    </div>
  );
}
