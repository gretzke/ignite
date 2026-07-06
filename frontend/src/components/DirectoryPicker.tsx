import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Folder, GitBranch } from 'lucide-react';
import type { ListDirectoryData } from '@ignite/api';
import { apiClient } from '../store/api/client';

interface DirectoryPickerProps {
  value: string;
  onChange: (path: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;
}

export function DirectoryPicker({
  value,
  onChange,
  onSubmit,
  autoFocus,
}: DirectoryPickerProps) {
  const dispatch = useDispatch();
  const [chain, setChain] = useState<ListDirectoryData | null>(null);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const lastRequestedRef = useRef<string | null>(null);
  const immediateRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const fetchChain = useCallback(
    (path: string) => {
      lastRequestedRef.current = path;
      dispatch(
        apiClient.dispatch.listDirectory({
          body: { path },
          onSuccess: (data) => {
            if (lastRequestedRef.current !== path) return;
            setChain(data);
            setError(
              data.requestedPathExists ? '' : 'Directory does not exist'
            );
            // Pre-fill the empty input with the starting directory
            if (path.trim() === '' && data.requestedPathExists) {
              lastRequestedRef.current = data.resolvedPath;
              onChangeRef.current(data.resolvedPath);
            }
          },
          onError: (apiError) => {
            if (lastRequestedRef.current !== path) return;
            setError(
              apiError.body.code === 'INVALID_PATH'
                ? 'Please enter an absolute path (e.g., /Users/username/projects)'
                : apiError.body.message
            );
          },
        })
      );
    },
    [dispatch]
  );

  // Two-way bind: value -> columns (immediate for clicks, debounced for typing)
  useEffect(() => {
    if (lastRequestedRef.current === value) return;
    if (immediateRef.current === value) {
      immediateRef.current = null;
      fetchChain(value);
      return;
    }
    const timer = setTimeout(() => fetchChain(value), 250);
    return () => clearTimeout(timer);
  }, [value, fetchChain]);

  // Keep the deepest column in view as the chain grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [chain]);

  const handleEntryClick = (columnPath: string, name: string) => {
    const next = joinPath(columnPath, name);
    immediateRef.current = next;
    setError('');
    onChange(next);
  };

  const pathExists = chain?.requestedPathExists ?? false;

  return (
    <div>
      <input
        type="text"
        placeholder="/Users/username/projects/my-repo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && pathExists && !error) onSubmit?.();
        }}
        className="input-glass"
        autoFocus={autoFocus}
        spellCheck={false}
      />
      {error && <div className="text-xs text-err mt-1">{error}</div>}

      <div
        ref={scrollRef}
        className="dir-picker-columns flex overflow-x-auto rounded-lg mt-3"
        style={{ height: 224 }}
      >
        {(chain?.columns ?? []).map((column) => {
          const visibleEntries = column.entries.filter(
            (entry) => showHidden || !entry.isHidden
          );
          return (
            <div
              key={column.path}
              className="dir-picker-column w-48 shrink-0 overflow-y-auto py-1"
            >
              {visibleEntries.length === 0 && (
                <div className="text-xs opacity-50 px-2 py-1">
                  No subfolders
                </div>
              )}
              {visibleEntries.map((entry) => {
                const entryPath = joinPath(column.path, entry.name);
                const selected =
                  chain !== null &&
                  (chain.resolvedPath === entryPath ||
                    chain.resolvedPath.startsWith(`${entryPath}/`));
                return (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => handleEntryClick(column.path, entry.name)}
                    className={`dir-picker-entry flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm ${
                      selected ? 'dir-picker-entry-selected' : ''
                    }`}
                    title={entryPath}
                  >
                    <Folder size={14} className="shrink-0 opacity-70" />
                    <span className="truncate">{entry.name}</span>
                    {entry.isGitRepo && (
                      <GitBranch
                        size={12}
                        className="ml-auto shrink-0 text-ok"
                        aria-label="Git repository"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <label className="flex items-center gap-2 mt-2 text-xs opacity-70 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
        />
        Show hidden folders
      </label>
    </div>
  );
}
