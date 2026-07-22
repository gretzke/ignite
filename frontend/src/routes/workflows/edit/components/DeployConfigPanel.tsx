import { useEffect, useState } from 'react';
import type {
  WorkflowDeployStrategy,
  WorkflowDocument,
  WorkflowRequiredPlugin,
} from '@ignite/api';
import {
  makeWorkflowDocumentSchema,
  validateWorkflowClosure,
} from '@ignite/api';
import type { PluginRow } from '../../../../store/features/plugins/pluginsSlice';

const zeroSalt = `0x${'0'.repeat(64)}`;
const hex32 = /^0x[0-9a-fA-F]{64}$/;

export function deployStrategyPlugins(rows: PluginRow[]): PluginRow[] {
  return rows.filter(
    (plugin) =>
      plugin.trust !== 'untrusted' &&
      plugin.types.includes('deployment-type') &&
      Boolean(plugin.version)
  );
}

function addRequiredPlugin(
  doc: WorkflowDocument,
  plugin: PluginRow
): WorkflowDocument {
  const next = structuredClone(doc);
  if (!next.requiredPlugins.some((item) => item.id === plugin.pluginId)) {
    const required: WorkflowRequiredPlugin = {
      id: plugin.pluginId,
      version: plugin.version!,
      ...(plugin.source ? { source: plugin.source } : {}),
    };
    next.requiredPlugins.push(required);
  }
  makeWorkflowDocumentSchema().parse(next);
  const missing = validateWorkflowClosure(next);
  if (missing.length)
    throw new Error(`Workflow closure is missing: ${missing.join(', ')}`);
  return next;
}

export function applyDeployStrategy(
  document: WorkflowDocument,
  stepId: string,
  strategy: WorkflowDeployStrategy,
  plugin?: PluginRow
): WorkflowDocument {
  let next = structuredClone(document);
  const step = next.steps.find(
    (item) => item.id === stepId && item.kind === 'deploy'
  );
  if (!step || step.kind !== 'deploy')
    throw new Error(`Deploy step not found: ${stepId}`);
  step.strategy = strategy;
  if (plugin && strategy.kind === 'plugin')
    next = addRequiredPlugin(next, plugin);
  makeWorkflowDocumentSchema().parse(next);
  const missing = validateWorkflowClosure(next);
  if (missing.length)
    throw new Error(`Workflow closure is missing: ${missing.join(', ')}`);
  return next;
}

export default function DeployConfigPanel({
  document,
  sourceId,
  plugins,
  onChange,
}: {
  document: WorkflowDocument;
  sourceId: string;
  plugins: PluginRow[];
  onChange: (document: WorkflowDocument) => void;
}) {
  const step = document.steps.find(
    (item) => item.kind === 'deploy' && item.contractId === sourceId
  );
  const strategy =
    step?.kind === 'deploy'
      ? (step.strategy ?? { kind: 'create' as const })
      : { kind: 'create' as const };
  const [paramsText, setParamsText] = useState(
    strategy.kind === 'plugin' && strategy.params
      ? JSON.stringify(strategy.params, null, 2)
      : ''
  );
  useEffect(
    () =>
      setParamsText(
        strategy.kind === 'plugin' && strategy.params
          ? JSON.stringify(strategy.params, null, 2)
          : ''
      ),
    [strategy]
  );
  if (!step || step.kind !== 'deploy') return null;
  const candidates = deployStrategyPlugins(plugins);
  const selected =
    strategy.kind === 'plugin' ? `plugin:${strategy.pluginId}` : strategy.kind;
  const write = (next: WorkflowDeployStrategy, plugin?: PluginRow) =>
    onChange(applyDeployStrategy(document, step.id, next, plugin));
  const changeKind = (value: string) => {
    if (value === 'create') write({ kind: 'create' });
    else if (value === 'create2') write({ kind: 'create2', salt: zeroSalt });
    else {
      const plugin = candidates.find(
        (item) => item.pluginId === value.slice(7)
      );
      if (plugin) write({ kind: 'plugin', pluginId: plugin.pluginId }, plugin);
    }
  };
  const updateSalt = (salt: string, chainId?: string) => {
    if (!hex32.test(salt)) return;
    if (strategy.kind !== 'create2' && strategy.kind !== 'plugin') return;
    const saltPerChain = chainId
      ? { ...strategy.saltPerChain, [chainId]: salt }
      : strategy.saltPerChain;
    write({
      ...strategy,
      ...(chainId ? { saltPerChain } : { salt }),
    } as WorkflowDeployStrategy);
  };
  return (
    <section className="mt-4 border-t border-white/10 pt-3 grid gap-3">
      <label className="grid gap-1 text-sm">
        <span className="eyebrow">Deployment type</span>
        <select
          className="input-glass"
          value={selected}
          onChange={(event) => changeKind(event.target.value)}
        >
          <option value="create">Create</option>
          <option value="create2">Create2</option>
          {candidates.map((plugin) => (
            <option key={plugin.pluginId} value={`plugin:${plugin.pluginId}`}>
              {plugin.name ?? plugin.pluginId}
            </option>
          ))}
        </select>
      </label>
      {strategy.kind === 'create2' && (
        <SaltFields
          strategy={strategy}
          onChange={updateSalt}
          chains={document.defaultChains ?? []}
        />
      )}
      {strategy.kind === 'plugin' && (
        <>
          <label className="grid gap-1 text-sm">
            <span className="eyebrow">Plugin params (JSON)</span>
            <textarea
              className="input-glass mono-data min-h-20"
              value={paramsText}
              onChange={(event) => setParamsText(event.target.value)}
              onBlur={() => {
                try {
                  write({
                    ...strategy,
                    ...(paramsText.trim()
                      ? {
                          params: JSON.parse(paramsText) as Record<
                            string,
                            unknown
                          >,
                        }
                      : {}),
                  });
                } catch {
                  /* Retain valid draft until JSON is corrected. */
                }
              }}
            />
          </label>
          <SaltFields strategy={strategy} onChange={updateSalt} optional />
        </>
      )}
    </section>
  );
}

function SaltFields({
  strategy,
  onChange,
  optional = false,
  chains = [],
}: {
  strategy: Extract<WorkflowDeployStrategy, { kind: 'create2' | 'plugin' }>;
  onChange: (salt: string, chainId?: string) => void;
  optional?: boolean;
  chains?: number[];
}) {
  const [salt, setSalt] = useState(strategy.salt ?? '');
  useEffect(() => setSalt(strategy.salt ?? ''), [strategy.salt]);
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm">
        <span className="eyebrow">{optional ? 'Salt (optional)' : 'Salt'}</span>
        <input
          className="input-glass mono-data"
          value={salt}
          placeholder="0x… (32 bytes)"
          onChange={(event) => setSalt(event.target.value)}
          onBlur={() => onChange(salt)}
        />
        {salt && !hex32.test(salt) && (
          <span className="text-xs text-err">Use a 32-byte hex value.</span>
        )}
      </label>
      {chains.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">
            Per-chain salts
          </summary>
          <div className="grid gap-2 mt-2">
            {chains.map((chainId) => (
              <label key={chainId} className="grid gap-1">
                <span className="text-xs">Chain {chainId}</span>
                <input
                  className="input-glass mono-data"
                  defaultValue={strategy.saltPerChain?.[String(chainId)] ?? ''}
                  placeholder="Use global salt"
                  onBlur={(event) => {
                    if (event.target.value)
                      onChange(event.target.value, String(chainId));
                  }}
                />
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
