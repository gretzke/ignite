import { useEffect, useMemo, useState } from 'react';
import type {
  DeploymentTypeInfo,
  WorkflowDeployStrategy,
  WorkflowDocument,
  WorkflowRequiredPlugin,
} from '@ignite/api';
import {
  makeWorkflowDocumentSchema,
  sanitizeDisplayText,
  stripGitUrlCredentials,
  validateWorkflowClosure,
} from '@ignite/api';
import { apiClient } from '../../../../store/api/client';
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

export function validateStrategyParams(
  params: Record<string, unknown> | undefined,
  descriptor: DeploymentTypeInfo
): Record<string, string> {
  const value = params ?? {};
  const fields = new Map(descriptor.params.map((field) => [field.key, field]));
  const errors: Record<string, string> = {};
  for (const key of Object.keys(value))
    if (!fields.has(key))
      errors[key] =
        'This parameter is not supported by the selected deployment type.';
  for (const field of descriptor.params) {
    const item = value[field.key];
    if (field.required && (item === undefined || item === ''))
      errors[field.key] = 'This field is required.';
    else if (
      item !== undefined &&
      (((field.type === 'string' || field.type === 'select') &&
        typeof item !== 'string') ||
        (field.type === 'number' &&
          (typeof item !== 'number' || !Number.isFinite(item))) ||
        (field.type === 'boolean' && typeof item !== 'boolean'))
    )
      errors[field.key] = `Use a ${field.type} value.`;
    else if (
      field.type === 'select' &&
      item !== undefined &&
      !field.options?.some((option) => option.value === item)
    )
      errors[field.key] = 'Choose one of the listed values.';
  }
  return errors;
}

function addRequiredPlugin(
  doc: WorkflowDocument,
  plugin: PluginRow
): WorkflowDocument {
  const next = globalThis.structuredClone(doc);
  if (!next.requiredPlugins.some((item) => item.id === plugin.pluginId)) {
    const source =
      plugin.source?.kind === 'git'
        ? { ...plugin.source, url: stripGitUrlCredentials(plugin.source.url) }
        : plugin.source;
    const required: WorkflowRequiredPlugin = {
      id: plugin.pluginId,
      version: plugin.version!,
      ...(source ? { source } : {}),
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
  let next = globalThis.structuredClone(document);
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
  onValidityChange,
}: {
  document: WorkflowDocument;
  sourceId: string;
  plugins: PluginRow[];
  onChange: (document: WorkflowDocument) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const step = document.steps.find(
    (item) => item.kind === 'deploy' && item.contractId === sourceId
  );
  const strategy = useMemo(
    () =>
      step?.kind === 'deploy'
        ? (step.strategy ?? { kind: 'create' as const })
        : { kind: 'create' as const },
    [step]
  );
  const [types, setTypes] = useState<DeploymentTypeInfo[]>([]);
  const [typesError, setTypesError] = useState('');
  const [credentialsRemoved, setCredentialsRemoved] = useState(false);
  const descriptors = useMemo(
    () => new Map(types.map((item) => [item.pluginId, item])),
    [types]
  );
  const descriptor =
    strategy.kind === 'plugin' ? descriptors.get(strategy.pluginId) : undefined;
  const params = useMemo(
    () => (strategy.kind === 'plugin' ? (strategy.params ?? {}) : {}),
    [strategy]
  );
  const paramErrors = useMemo(
    () => (descriptor ? validateStrategyParams(params, descriptor) : {}),
    [descriptor, params]
  );
  useEffect(() => {
    let live = true;
    void apiClient
      .request('listDeploymentTypes', {})
      .then((response) => {
        if (live && 'data' in response) setTypes(response.data.deploymentTypes);
      })
      .catch(() => {
        if (live)
          setTypesError('Deployment type descriptors could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!step || step.kind !== 'deploy') return;
    onValidityChange?.(
      strategy.kind !== 'plugin' ||
        (Boolean(descriptor) && Object.keys(paramErrors).length === 0)
    );
  }, [descriptor, onValidityChange, paramErrors, step, strategy.kind]);
  if (!step || step.kind !== 'deploy') return null;
  const candidates = deployStrategyPlugins(plugins).filter((plugin) =>
    descriptors.has(plugin.pluginId)
  );
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
      if (plugin) {
        if (
          plugin.source?.kind === 'git' &&
          stripGitUrlCredentials(plugin.source.url) !== plugin.source.url
        )
          setCredentialsRemoved(true);
        write({ kind: 'plugin', pluginId: plugin.pluginId }, plugin);
      }
    }
  };
  const updateSalt = (salt: string, chainId?: string) => {
    if (
      (salt && !hex32.test(salt)) ||
      (strategy.kind !== 'create2' && strategy.kind !== 'plugin')
    )
      return;
    if (chainId) {
      const saltPerChain = { ...strategy.saltPerChain };
      if (salt) saltPerChain[chainId] = salt;
      else delete saltPerChain[chainId];
      const { saltPerChain: _saltPerChain, ...withoutSaltPerChain } = strategy;
      write({
        ...withoutSaltPerChain,
        ...(Object.keys(saltPerChain).length ? { saltPerChain } : {}),
      } as WorkflowDeployStrategy);
      return;
    }
    const { salt: _salt, ...withoutSalt } = strategy;
    write({
      ...withoutSalt,
      ...(salt ? { salt } : {}),
    } as WorkflowDeployStrategy);
  };
  const changeParam = (key: string, value: unknown) => {
    if (strategy.kind !== 'plugin' || !descriptor) return;
    const next = { ...params };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    const { params: _params, ...withoutParams } = strategy;
    write({
      ...withoutParams,
      ...(Object.keys(next).length ? { params: next } : {}),
    });
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
              {sanitizeDisplayText(plugin.name ?? plugin.pluginId)}
            </option>
          ))}
        </select>
      </label>
      {typesError && <span className="text-xs text-err">{typesError}</span>}
      {credentialsRemoved && (
        <span className="text-xs pill-warning">
          Credentials removed from plugin source.
        </span>
      )}
      {strategy.kind === 'create2' && (
        <SaltFields
          strategy={strategy}
          onChange={updateSalt}
          chains={document.defaultChains ?? []}
        />
      )}
      {strategy.kind === 'plugin' && (
        <>
          {!descriptor && (
            <span className="text-xs text-err">
              This deployment type is unavailable; choose a descriptor-backed
              type before saving.
            </span>
          )}
          {descriptor?.params.map((field) => (
            <label key={field.key} className="grid gap-1 text-sm">
              <span className="eyebrow">
                {sanitizeDisplayText(field.label)}
              </span>
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={params[field.key] === true}
                  onChange={(event) =>
                    changeParam(field.key, event.target.checked)
                  }
                />
              ) : field.type === 'select' ? (
                <select
                  className="input-glass"
                  value={
                    typeof params[field.key] === 'string'
                      ? (params[field.key] as string)
                      : ''
                  }
                  onChange={(event) =>
                    changeParam(field.key, event.target.value)
                  }
                >
                  <option value="">Choose…</option>
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {sanitizeDisplayText(option.label)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input-glass"
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={
                    typeof params[field.key] === 'string' ||
                    typeof params[field.key] === 'number'
                      ? String(params[field.key])
                      : ''
                  }
                  onChange={(event) =>
                    changeParam(
                      field.key,
                      field.type === 'number' && event.target.value
                        ? Number(event.target.value)
                        : event.target.value
                    )
                  }
                />
              )}
              {field.description && (
                <span className="text-xs text-muted">
                  {sanitizeDisplayText(field.description)}
                </span>
              )}
              {paramErrors[field.key] && (
                <span className="text-xs text-err">
                  {paramErrors[field.key]}
                </span>
              )}
            </label>
          ))}
          {Object.entries(paramErrors)
            .filter(
              ([key]) => !descriptor?.params.some((field) => field.key === key)
            )
            .map(([key, error]) => (
              <span key={key} className="text-xs text-err">
                {sanitizeDisplayText(key)}: {error}
              </span>
            ))}
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
  const [perChain, setPerChain] = useState<Record<string, string>>(
    strategy.saltPerChain ?? {}
  );
  useEffect(() => setSalt(strategy.salt ?? ''), [strategy.salt]);
  useEffect(
    () => setPerChain(strategy.saltPerChain ?? {}),
    [strategy.saltPerChain]
  );
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
            {chains.map((chainId) => {
              const key = String(chainId);
              const value = perChain[key] ?? '';
              return (
                <label key={chainId} className="grid gap-1">
                  <span className="text-xs">Chain {chainId}</span>
                  <input
                    className="input-glass mono-data"
                    value={value}
                    placeholder="Use global salt"
                    onChange={(event) =>
                      setPerChain((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    onBlur={() => onChange(value, key)}
                  />
                  {value && !hex32.test(value) && (
                    <span className="text-xs text-err">
                      Use a 32-byte hex value.
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
