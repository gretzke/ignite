import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import Switch from './Switch';
import Select from './Select';
import ConfirmDialog from './ConfirmDialog';
import { useAppDispatch, useAppSelector } from '../store';
import {
  closeConfigModal,
  pluginsApi,
  selectConfigModal,
  selectPluginConfig,
  selectPluginRow,
} from '../store/features/plugins/pluginsSlice';
import { chainsApi } from '../store/features/chains/chainsSlice';
import type {
  GetPluginConfigData,
  PluginConfigField,
  PluginConfigListItemField,
  PluginConfigPrimitive,
  PluginConfigListItemValue,
  PluginConfigStoredValue,
} from '@ignite/api';
import type { RootState } from '../store/store';

const asPrimitive = (
  value: PluginConfigStoredValue | undefined
): PluginConfigPrimitive | undefined =>
  Array.isArray(value) ? undefined : value;

const asListItems = (
  value: PluginConfigStoredValue | undefined
): PluginConfigListItemValue[] => (Array.isArray(value) ? value : []);

// A non-secret value: string/number free-text fields use a local draft +
// explicit Save (so we don't fire a request per keystroke); booleans and
// selects are discrete choices and save immediately on change.
function GlobalValueControl({
  pluginId,
  field,
  value,
  chainId,
  onSaved,
}: {
  pluginId: string;
  field: PluginConfigField;
  value: PluginConfigPrimitive | undefined;
  chainId?: number;
  onSaved?: () => void;
}) {
  const dispatch = useAppDispatch();
  const currentStr = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(currentStr);

  useEffect(() => {
    setDraft(currentStr);
  }, [currentStr]);

  const save = (v: PluginConfigPrimitive) => {
    dispatch(
      pluginsApi.setConfigValue(pluginId, { key: field.key, value: v, chainId })
    );
    onSaved?.();
  };

  if (field.type === 'boolean') {
    return (
      <Switch checked={Boolean(value)} onCheckedChange={(checked) => save(checked)} />
    );
  }

  if (field.type === 'select') {
    return (
      <Select
        portal={false}
        options={field.options ?? []}
        value={value !== undefined ? String(value) : undefined}
        placeholder="Select…"
        onValueChange={(v) => save(v)}
      />
    );
  }

  const dirty = draft !== currentStr;
  const numberInvalid =
    field.type === 'number' && draft !== '' && Number.isNaN(Number(draft));

  return (
    <div className="flex items-center gap-2 flex-1">
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        className="input-glass flex-1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {dirty && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={numberInvalid}
          onClick={() => save(field.type === 'number' ? Number(draft) : draft)}
        >
          Save
        </button>
      )}
    </div>
  );
}

// A `file` field's VALUE is a host file PATH (plaintext, non-secret — the
// same store as a string field), shown/edited here like one. Core reads the
// file at that path and injects its CONTENTS under the field's key at
// invocation time, gated by the secret-scope grant (see
// PluginPermissionsModal) — never the path itself, which is always visible.
function FileValueControl({
  pluginId,
  field,
  value,
  onSaved,
}: {
  pluginId: string;
  field: PluginConfigField;
  value: PluginConfigPrimitive | undefined;
  onSaved?: () => void;
}) {
  const dispatch = useAppDispatch();
  const currentStr = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(currentStr);

  useEffect(() => {
    setDraft(currentStr);
  }, [currentStr]);

  const dirty = draft !== currentStr;

  const save = () => {
    dispatch(
      pluginsApi.setConfigValue(pluginId, { key: field.key, value: draft })
    );
    onSaved?.();
  };

  const reset = () => {
    dispatch(pluginsApi.deleteConfigValue(pluginId, field.key));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="input-glass mono-data flex-1"
          placeholder={field.default}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {dirty && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={save}
          >
            Save
          </button>
        )}
        {value !== undefined && (
          <button
            type="button"
            className="btn-sm btn-secondary-borderless"
            onClick={reset}
          >
            Reset to default
          </button>
        )}
      </div>
      <span className="text-xs text-muted">
        File contents are provided to the plugin when it runs — requires the
        access grant in Manage Permissions.
      </span>
    </div>
  );
}

// Secret values are never read back — only whether an entry is currently
// stored (`present`). Submits via setSecret; a stored entry can be cleared
// via deleteConfigValue but never displayed.
function SecretControl({
  pluginId,
  field,
  chainId,
  present,
  onSaved,
}: {
  pluginId: string;
  field: PluginConfigField;
  chainId?: number;
  present: boolean;
  onSaved?: () => void;
}) {
  const dispatch = useAppDispatch();
  const [draft, setDraft] = useState('');

  const handleSet = () => {
    if (!draft) return;
    dispatch(
      pluginsApi.setSecret(pluginId, { key: field.key, value: draft, chainId })
    );
    setDraft('');
    onSaved?.();
  };

  const handleClear = () => {
    dispatch(pluginsApi.deleteConfigValue(pluginId, field.key, chainId));
  };

  return (
    <div className="flex items-center gap-2 flex-1">
      {present && (
        <span className="mono-data text-muted shrink-0">•••• set</span>
      )}
      <input
        type="password"
        className="input-glass flex-1"
        placeholder={present ? 'Replace value' : 'Set value'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!draft}
        onClick={handleSet}
      >
        {present ? 'Replace' : 'Set'}
      </button>
      {present && (
        <button
          type="button"
          className="btn btn-danger btn-sm"
          aria-label="Clear secret"
          onClick={handleClear}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function ListItemTextInput({
  itemField,
  value,
  onChange,
  secret,
  present,
}: {
  itemField: PluginConfigListItemField;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  present?: boolean;
}) {
  return (
    <label className="grid gap-1 min-w-0">
      <span className="text-xs text-muted">
        {itemField.label}
        {itemField.required ? ' *' : ''}
      </span>
      <input
        type={secret ? 'password' : 'text'}
        className="input-glass"
        placeholder={secret && present ? 'Replace value' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ExistingListItemRow({
  pluginId,
  field,
  item,
  secretsPresent,
}: {
  pluginId: string;
  field: PluginConfigField;
  item: PluginConfigListItemValue;
  secretsPresent: string[];
}) {
  const dispatch = useAppDispatch();
  const itemFields = field.itemFields ?? [];
  const nonSecretFields = itemFields.filter((itemField) => !itemField.secret);
  const secretFields = itemFields.filter((itemField) => itemField.secret);
  const currentValues = Object.fromEntries(
    nonSecretFields.map((itemField) => [
      itemField.key,
      item.values[itemField.key] ?? '',
    ])
  );
  const [draftValues, setDraftValues] =
    useState<Record<string, string>>(currentValues);
  const [draftSecrets, setDraftSecrets] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    setDraftValues(currentValues);
    setDraftSecrets({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, JSON.stringify(currentValues)]);

  const secretPresent = (itemFieldKey: string) =>
    secretsPresent.includes(`${field.key}.${item.id}.${itemFieldKey}`);
  const dirtyValues = nonSecretFields.some(
    (itemField) =>
      (draftValues[itemField.key] ?? '') !==
      (item.values[itemField.key] ?? '')
  );
  const dirtySecrets = secretFields.some(
    (itemField) => (draftSecrets[itemField.key] ?? '') !== ''
  );
  const missingRequired = itemFields.some((itemField) => {
    if (!itemField.required) return false;
    if (itemField.secret) {
      return !secretPresent(itemField.key) && !draftSecrets[itemField.key];
    }
    return !(draftValues[itemField.key] ?? '').trim();
  });

  const save = () => {
    if (missingRequired || (!dirtyValues && !dirtySecrets)) return;
    const values = Object.fromEntries(
      nonSecretFields.map((itemField) => [
        itemField.key,
        draftValues[itemField.key] ?? '',
      ])
    );
    const secrets = Object.fromEntries(
      secretFields
        .filter((itemField) => draftSecrets[itemField.key])
        .map((itemField) => [itemField.key, draftSecrets[itemField.key]])
    );
    dispatch(
      pluginsApi.upsertConfigListItem(pluginId, {
        fieldKey: field.key,
        itemId: item.id,
        values,
        secrets,
      })
    );
    setDraftSecrets({});
  };

  return (
    <>
      <div className="list-row">
        <div className="grid gap-3 w-full min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted mono-data truncate">
              {item.id}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {(dirtyValues || dirtySecrets) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={missingRequired}
                  onClick={save}
                >
                  Save
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-secondary-borderless"
                aria-label="Remove item"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <div className="grid gap-2">
            {nonSecretFields.map((itemField) => (
              <ListItemTextInput
                key={itemField.key}
                itemField={itemField}
                value={draftValues[itemField.key] ?? ''}
                onChange={(value) =>
                  setDraftValues((draft) => ({
                    ...draft,
                    [itemField.key]: value,
                  }))
                }
              />
            ))}
            {secretFields.map((itemField) => {
              const present = secretPresent(itemField.key);
              return (
                <div key={itemField.key} className="grid gap-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted">
                      {itemField.label}
                      {itemField.required ? ' *' : ''}
                    </span>
                    {present && (
                      <span className="mono-data text-muted text-xs shrink-0">
                        •••• set
                      </span>
                    )}
                  </div>
                  <input
                    type="password"
                    className="input-glass"
                    placeholder={present ? 'Replace value' : 'Set value'}
                    value={draftSecrets[itemField.key] ?? ''}
                    onChange={(e) =>
                      setDraftSecrets((draft) => ({
                        ...draft,
                        [itemField.key]: e.target.value,
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove list item?"
        description={`Remove item ${item.id} from ${field.label}. Stored secret values for this item will also be removed.`}
        confirmText="Remove"
        onConfirm={() =>
          dispatch(pluginsApi.deleteConfigListItem(pluginId, field.key, item.id))
        }
      />
    </>
  );
}

function AddListItemRow({
  pluginId,
  field,
}: {
  pluginId: string;
  field: PluginConfigField;
}) {
  const dispatch = useAppDispatch();
  const itemFields = field.itemFields ?? [];
  const nonSecretFields = itemFields.filter((itemField) => !itemField.secret);
  const secretFields = itemFields.filter((itemField) => itemField.secret);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [draftSecrets, setDraftSecrets] = useState<Record<string, string>>({});

  const missingRequired = itemFields.some((itemField) => {
    if (!itemField.required) return false;
    const source = itemField.secret ? draftSecrets : draftValues;
    return !(source[itemField.key] ?? '').trim();
  });
  const hasAnyValue = itemFields.some((itemField) => {
    const source = itemField.secret ? draftSecrets : draftValues;
    return (source[itemField.key] ?? '').trim() !== '';
  });

  const add = () => {
    if (missingRequired || !hasAnyValue) return;
    const values = Object.fromEntries(
      nonSecretFields
        .filter((itemField) => draftValues[itemField.key] !== undefined)
        .map((itemField) => [itemField.key, draftValues[itemField.key]])
    );
    const secrets = Object.fromEntries(
      secretFields
        .filter((itemField) => draftSecrets[itemField.key])
        .map((itemField) => [itemField.key, draftSecrets[itemField.key]])
    );
    dispatch(
      pluginsApi.upsertConfigListItem(pluginId, {
        fieldKey: field.key,
        values,
        secrets,
      })
    );
    setDraftValues({});
    setDraftSecrets({});
  };

  return (
    <div className="list-row">
      <div className="grid gap-3 w-full min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">Add item</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={missingRequired || !hasAnyValue}
            onClick={add}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
        <div className="grid gap-2">
          {nonSecretFields.map((itemField) => (
            <ListItemTextInput
              key={itemField.key}
              itemField={itemField}
              value={draftValues[itemField.key] ?? ''}
              onChange={(value) =>
                setDraftValues((draft) => ({
                  ...draft,
                  [itemField.key]: value,
                }))
              }
            />
          ))}
          {secretFields.map((itemField) => (
            <ListItemTextInput
              key={itemField.key}
              itemField={itemField}
              secret
              value={draftSecrets[itemField.key] ?? ''}
              onChange={(value) =>
                setDraftSecrets((draft) => ({
                  ...draft,
                  [itemField.key]: value,
                }))
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ListValueControl({
  pluginId,
  field,
  values,
  secretsPresent,
}: {
  pluginId: string;
  field: PluginConfigField;
  values: PluginConfigListItemValue[];
  secretsPresent: string[];
}) {
  return (
    <div className="grid gap-2">
      <div className="glass-list">
        {values.length === 0 && (
          <div className="list-row text-muted">No items configured.</div>
        )}
        {values.map((item) => (
          <ExistingListItemRow
            key={item.id}
            pluginId={pluginId}
            field={field}
            item={item}
            secretsPresent={secretsPresent}
          />
        ))}
        <AddListItemRow pluginId={pluginId} field={field} />
      </div>
    </div>
  );
}

function ConfigFieldCard({
  pluginId,
  field,
  config,
  chains,
}: {
  pluginId: string;
  field: PluginConfigField;
  config: GetPluginConfigData;
  chains: RootState['chains']['chains'];
}) {
  const dispatch = useAppDispatch();
  const shape = config.values[field.key];
  const [newChainId, setNewChainId] = useState('');

  // Existing overrides: secret perChain entries only ever show up as
  // `key::chainId` descriptors in secretsPresent (their value is never
  // returned); plain perChain entries come back in values[key].perChain.
  const overrideChainIds = field.secret
    ? config.secretsPresent
        .filter((k) => k.startsWith(`${field.key}::`))
        .map((k) => k.slice(field.key.length + 2))
    : Object.keys(shape?.perChain ?? {});

  const usedChainIds = new Set(overrideChainIds);
  const chainOptions = chains
    .filter((c) => !usedChainIds.has(String(c.chainId)))
    .map((c) => ({ value: String(c.chainId), label: c.name }));

  const chainName = (id: string) =>
    chains.find((c) => String(c.chainId) === id)?.name ?? `Chain ${id}`;

  return (
    <div className="card-milky p-3 flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{field.label}</span>
          {field.required && (
            <span className="text-xs text-muted">required</span>
          )}
        </div>
        {/* Plugin-authored text: rendered strictly as plain text */}
        {field.description && (
          <div className="text-sm opacity-80 mt-1 break-words">
            {field.description}
          </div>
        )}
      </div>

      {field.secret ? (
        <SecretControl
          pluginId={pluginId}
          field={field}
          present={config.secretsPresent.includes(field.key)}
        />
      ) : field.type === 'list' ? (
        <ListValueControl
          pluginId={pluginId}
          field={field}
          values={asListItems(shape?.global)}
          secretsPresent={config.secretsPresent}
        />
      ) : field.type === 'file' ? (
        <FileValueControl
          pluginId={pluginId}
          field={field}
          value={asPrimitive(shape?.global)}
        />
      ) : (
        <GlobalValueControl
          pluginId={pluginId}
          field={field}
          value={asPrimitive(shape?.global)}
        />
      )}

      {field.perChain && (
        <div
          className="flex flex-col gap-2 pl-3 ml-1"
          style={{ borderLeft: '2px solid var(--hairline)' }}
        >
          <span className="text-xs text-muted">Per-chain overrides</span>
          {overrideChainIds.length === 0 && (
            <span className="text-xs opacity-60">No overrides.</span>
          )}
          {overrideChainIds.map((id) => (
            <div key={id} className="flex items-center gap-2">
              <span className="text-xs mono-data shrink-0" style={{ width: 96 }}>
                {chainName(id)}
              </span>
              {field.secret ? (
                <SecretControl
                  pluginId={pluginId}
                  field={field}
                  chainId={Number(id)}
                  present
                />
              ) : (
                <>
                  <GlobalValueControl
                    pluginId={pluginId}
                    field={field}
                    chainId={Number(id)}
                    value={shape?.perChain?.[id]}
                  />
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    aria-label="Remove override"
                    onClick={() =>
                      dispatch(
                        pluginsApi.deleteConfigValue(
                          pluginId,
                          field.key,
                          Number(id)
                        )
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))}

          <div className="flex items-center gap-2">
            <div style={{ width: 160 }} className="shrink-0">
              <Select
                portal={false}
                options={chainOptions}
                value={newChainId || undefined}
                placeholder="Add chain…"
                onValueChange={setNewChainId}
              />
            </div>
            {newChainId &&
              (field.secret ? (
                <SecretControl
                  key={newChainId}
                  pluginId={pluginId}
                  field={field}
                  chainId={Number(newChainId)}
                  present={false}
                  onSaved={() => setNewChainId('')}
                />
              ) : (
                <GlobalValueControl
                  key={newChainId}
                  pluginId={pluginId}
                  field={field}
                  chainId={Number(newChainId)}
                  value={undefined}
                  onSaved={() => setNewChainId('')}
                />
              ))}
            {!newChainId && (
              <span className="text-xs opacity-50 flex items-center gap-1">
                <Plus size={12} /> pick a chain to add an override
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Global auto-generated config form: one card per manifest-declared config
// field. Opened from a plugin card's Configure button (PluginsTab).
export default function PluginConfigModal() {
  const dispatch = useAppDispatch();
  const modal = useAppSelector(selectConfigModal);
  const row = useAppSelector((s: RootState) =>
    modal ? selectPluginRow(s, modal.pluginId) : undefined
  );
  const config = useAppSelector((s: RootState) =>
    modal ? selectPluginConfig(s, modal.pluginId) : undefined
  );
  const chains = useAppSelector((s: RootState) => s.chains.chains);

  useEffect(() => {
    if (!modal) return;
    dispatch(pluginsApi.fetchConfig(modal.pluginId));
    chainsApi.fetchChains().forEach((a) => dispatch(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal?.pluginId]);

  if (!modal) return null;

  const name = row?.name ?? modal.pluginId;
  const fields = config?.fields ?? row?.configFields ?? [];
  const close = () => dispatch(closeConfigModal());

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 560, width: '90vw', padding: 24 }}
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className="size-10 rounded-full flex items-center justify-center shrink-0"
              style={{
                background:
                  'color-mix(in oklch, var(--profile-color) 12%, transparent)',
                color: 'var(--profile-color)',
              }}
            >
              <Settings2 size={20} />
            </div>
            <Dialog.Title className="text-base font-semibold">
              {name} Plugin Configuration
            </Dialog.Title>
          </div>
          <Dialog.Description className="text-sm opacity-80 mb-4">
            Configure this plugin&apos;s settings.
            {fields.some((f) => f.secret === true) &&
              ' Secret values are write-only — once saved, they are never displayed again.'}
            {fields.some((f) => f.type === 'file') &&
              " File paths are stored in plain text; the file's contents are provided to the plugin only with your permission grant."}
          </Dialog.Description>

          {!config ? (
            <div className="text-sm opacity-70 py-6 text-center">
              Loading configuration…
            </div>
          ) : fields.length === 0 ? (
            <div className="text-sm opacity-70 py-6 text-center">
              This plugin has no configurable settings.
            </div>
          ) : (
            <div
              className="flex flex-col gap-3 mb-5"
              style={{ maxHeight: '60vh', overflowY: 'auto' }}
            >
              {fields.map((field) => (
                <ConfigFieldCard
                  key={field.key}
                  pluginId={modal.pluginId}
                  field={field}
                  config={config}
                  chains={chains}
                />
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
