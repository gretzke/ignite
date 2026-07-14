import type { LibraryBinding } from '@ignite/api';
import PointerValue from './PointerValue';
import { useAppDispatch, useAppSelector } from '../../../store';
import {
  setLibraries,
  setLibrariesPerChain,
} from '../../../store/features/deployments/deployDraftSlice';
import { eligiblePointerSteps } from '../pointerEligibility';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';

export interface LibraryReference {
  /** The compiler/core canonical link-reference key: `<sourcePath>:<name>`. */
  key: string;
  name: string;
  sourcePath: string;
}

type BindingValue =
  | string
  | { $ref: { kind: 'step'; stepId: string } }
  | undefined;

function bindingValue(binding: LibraryBinding | undefined): BindingValue {
  return binding?.kind === 'step'
    ? { $ref: { kind: 'step', stepId: binding.stepId } }
    : binding?.address;
}

function BindingField({
  library,
  binding,
  eligible,
  onChange,
  inherited,
}: {
  library: LibraryReference;
  binding?: LibraryBinding;
  eligible: ReturnType<typeof eligiblePointerSteps>;
  onChange: (value: BindingValue) => void;
  inherited?: boolean;
}) {
  const value = bindingValue(binding);
  return (
    <div className="grid gap-2">
      <div>
        <span className="text-sm font-medium">{library.name}</span>
        <p className="text-xs text-muted mono-data">{decodeUrlEncodingForDisplay(library.sourcePath)}</p>
      </div>
      <PointerValue value={value} eligibleSteps={eligible} onChange={onChange} />
      {binding?.kind !== 'step' && (
        <input
          className="input-glass"
          placeholder={inherited ? 'Use global binding' : '0x… library address'}
          value={binding?.address ?? ''}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      )}
    </div>
  );
}

export default function LibrariesSection({
  stepId,
  libraries,
}: {
  stepId: string;
  libraries: LibraryReference[];
}) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chainInfo = useAppSelector((state) => state.chains.chains);
  const extras = draft.deployExtras[stepId];
  const bindings = extras?.libraries ?? {};
  const bindingsPerChain = extras?.librariesPerChain ?? {};
  const eligible = eligiblePointerSteps(draft, stepId);
  const change = (key: string, value: BindingValue) => {
    const next = { ...bindings };
    if (!value) delete next[key];
    else if (typeof value === 'string')
      next[key] = { kind: 'address', address: value as `0x${string}` };
    else next[key] = { kind: 'step', stepId: value.$ref.stepId };
    dispatch(setLibraries({ stepId, libraries: Object.keys(next).length ? next : undefined }));
  };
  const changePerChain = (chainId: number, key: string, value: BindingValue) => {
    const chainKey = String(chainId);
    const next = { ...bindingsPerChain };
    const chainBindings = { ...(next[chainKey] ?? {}) };
    if (!value) delete chainBindings[key];
    else if (typeof value === 'string')
      chainBindings[key] = { kind: 'address', address: value as `0x${string}` };
    else chainBindings[key] = { kind: 'step', stepId: value.$ref.stepId };
    if (Object.keys(chainBindings).length) next[chainKey] = chainBindings;
    else delete next[chainKey];
    dispatch(setLibrariesPerChain({
      stepId,
      librariesPerChain: Object.keys(next).length ? next : undefined,
    }));
  };
  if (!libraries.length) return null;
  return (
    <section className="grid gap-3">
      <div><h4 className="font-medium">Libraries</h4><p className="text-xs text-muted">Link each library to an address or another deployment step.</p></div>
      {libraries.map((library) => (
        <BindingField key={library.key} library={library} binding={bindings[library.key]} eligible={eligible} onChange={(value) => change(library.key, value)} />
      ))}
      {draft.chains.length > 1 && <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain library bindings</summary><div className="grid gap-3 mt-2">{draft.chains.map((chainId) => <div key={chainId} className="card-milky p-3 grid gap-3"><span className="font-medium">{chainInfo.find((chain) => chain.chainId === chainId)?.name ?? chainId}</span>{libraries.map((library) => <BindingField key={library.key} library={library} binding={bindingsPerChain[String(chainId)]?.[library.key]} inherited eligible={eligible} onChange={(value) => changePerChain(chainId, library.key, value)} />)}</div>)}</div></details>}
    </section>
  );
}
