import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import type { ExplorerEntry } from '@ignite/api';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import { explorersApi } from '../../../store/api/explorersApi';
import { openConfigModal } from '../../../store/features/plugins/pluginsSlice';
import { explorerReceived } from '../../../store/features/explorers/explorersSlice';
import AdvancedStepSection from '../components/AdvancedStepSection';
import { apiClient } from '../../../store/api/client';

export interface ExplorerMultiSelectProps {
  chainIds: number[];
  selection: Record<string, string[]>;
  onSelectionChange: (selection: Record<string, string[]>) => void;
}

export function explorerNeedsAttention(
  entry: ExplorerEntry
): 'mapping' | 'configuration' | undefined {
  if (!entry.verifierPluginId) return 'mapping';
  if (entry.needsConfig) return 'configuration';
  return undefined;
}

export default function ExplorerMultiSelect({
  chainIds,
  selection,
  onSelectionChange,
}: ExplorerMultiSelectProps) {
  const dispatch = useAppDispatch();
  const explorers = useAppSelector((state) => state.explorers.byChain);
  const remembered = useAppSelector((state) => state.explorers.selection);
  const verifierPlugins = useAppSelector((state) =>
    Object.values(state.plugins.rows).filter((plugin) =>
      plugin.types.includes('verifier')
    )
  );
  const [newUrls, setNewUrls] = useState<Record<string, string>>({});
  const [mappingChoice, setMappingChoice] = useState<Record<string, string>>(
    {}
  );

  useEffect(() => {
    chainIds.forEach((chainId) => {
      if (explorers[String(chainId)] === undefined)
        explorersApi
          .fetchExplorers(chainId)
          .forEach((action) => dispatch(action));
    });
  }, [chainIds, dispatch, explorers]);

  // A remembered selection is a convenience, not a source of truth over a
  // draft the user has already edited. This also never applies a mapping
  // suggestion: only explicit checkbox selection is copied into the draft.
  useEffect(() => {
    const additions: Record<string, string[]> = {};
    for (const chainId of chainIds) {
      const key = String(chainId);
      if (!(key in selection) && explorers[key] !== undefined) {
        additions[key] = remembered[key] ?? [];
      }
    }
    if (Object.keys(additions).length)
      onSelectionChange({ ...selection, ...additions });
  }, [chainIds, explorers, onSelectionChange, remembered, selection]);

  const setChainSelection = (chainId: number, entryIds: string[]) => {
    const next = { ...selection, [String(chainId)]: entryIds };
    onSelectionChange(next);
    explorersApi
      .setSelection(chainId, entryIds)
      .forEach((action) => dispatch(action));
  };

  const add = async (chainId: number) => {
    const key = String(chainId);
    const url = newUrls[key]?.trim();
    if (!url) return;
    try {
      const response = await apiClient.request('addExplorer', {
        body: { chainId, url },
      });
      if (!('data' in response)) throw new Error(response.message);
      const entry = response.data.entry;
      dispatch(explorerReceived(entry));
      const next = new Set(selection[key] ?? []);
      next.add(entry.id);
      setChainSelection(chainId, [...next]);
      setNewUrls((current) => ({ ...current, [key]: '' }));
      explorersApi
        .fetchExplorers(chainId)
        .forEach((action) => dispatch(action));
    } catch {
      // The API middleware's normal add path displays its own toast; this
      // direct flow needs no optimistic mutation when the add is rejected.
    }
  };

  const pluginOptions = useMemo(
    () =>
      verifierPlugins.map((plugin) => ({
        value: plugin.pluginId,
        label: plugin.name ?? plugin.pluginId,
      })),
    [verifierPlugins]
  );

  return (
    <div className="grid gap-3">
      {chainIds.map((chainId) => {
        const key = String(chainId);
        const entries = explorers[key];
        const selected = new Set(selection[key] ?? []);
        return (
          <article key={chainId} className="card-milky p-4 grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">Chain {chainId}</h3>
                <p className="text-xs text-muted">
                  Select each explorer to verify after deployment.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() =>
                  explorersApi
                    .fetchExplorers(chainId)
                    .forEach((action) => dispatch(action))
                }
              >
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
            {entries === undefined ? (
              <p className="text-sm text-muted flex gap-2 items-center">
                <Loader2 size={14} className="animate-spin" /> Loading
                explorers…
              </p>
            ) : (
              <div className="grid gap-2">
                {entries.map((entry) => {
                  const attention = explorerNeedsAttention(entry);
                  const pending = mappingChoice[entry.id] ?? '';
                  const isSelected = selected.has(entry.id);
                  const pluginName =
                    verifierPlugins.find(
                      (plugin) => plugin.pluginId === entry.verifierPluginId
                    )?.name ?? entry.verifierPluginId;
                  return (
                    <div key={entry.id} className="glass-list">
                      <label className="list-row flex gap-3 items-start">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(entry.id);
                            else next.delete(entry.id);
                            setChainSelection(chainId, [...next]);
                          }}
                          aria-label={`Verify with ${entry.label ?? entry.url}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium truncate">
                            {entry.label ?? entry.url}
                          </span>
                          <span className="mono-data text-muted truncate block">
                            {entry.url} · {entry.source}
                          </span>
                        </span>
                        {entry.verifierPluginId && !isSelected && (
                          <span className="chip">{entry.verifierPluginId}</span>
                        )}
                      </label>
                      {isSelected && entry.verifierPluginId && (
                        <div className="px-3 pb-3 grid gap-2 text-sm">
                          <span>
                            Handled by{' '}
                            <span className="font-medium">{pluginName}</span>
                          </span>
                          <AdvancedStepSection label="Override mapping">
                            <Select
                              options={pluginOptions}
                              value={entry.verifierPluginId}
                              placeholder="Choose verifier type"
                              onValueChange={(verifierPluginId) =>
                                dispatch(
                                  explorersApi.updateExplorer(entry.id, {
                                    verifierPluginId,
                                  })
                                )
                              }
                            />
                          </AdvancedStepSection>
                        </div>
                      )}
                      {isSelected && attention === 'configuration' && (
                        <div className="px-3 pb-3 text-sm text-warn flex items-center gap-2">
                          This verifier needs configuration.
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() =>
                              dispatch(
                                openConfigModal({
                                  pluginId: entry.verifierPluginId!,
                                })
                              )
                            }
                          >
                            Configure
                          </button>
                        </div>
                      )}
                      {isSelected && attention === 'mapping' && (
                        <div className="px-3 pb-3 grid gap-2">
                          <span className="text-sm text-warn">
                            Choose verifier type
                            {entry.mappingSuggestion
                              ? ` (suggested: ${entry.mappingSuggestion})`
                              : ''}
                          </span>
                          <div className="flex gap-2 items-center">
                            <Select
                              options={pluginOptions}
                              value={pending}
                              placeholder="Choose verifier type"
                              onValueChange={(verifierPluginId) =>
                                setMappingChoice((current) => ({
                                  ...current,
                                  [entry.id]: verifierPluginId,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={!pending}
                              onClick={() => {
                                if (!pending) return;
                                dispatch(
                                  explorersApi.updateExplorer(entry.id, {
                                    verifierPluginId: pending,
                                  })
                                );
                              }}
                            >
                              Confirm mapping
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {entries.length === 0 && (
                  <p className="text-sm text-muted">No explorers found.</p>
                )}
              </div>
            )}
            <label className="flex gap-2">
              <input
                className="input-glass flex-1"
                value={newUrls[key] ?? ''}
                onChange={(event) =>
                  setNewUrls((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                placeholder="Add explorer URL"
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void add(chainId)}
              >
                <Plus size={14} /> Add
              </button>
            </label>
          </article>
        );
      })}
    </div>
  );
}
