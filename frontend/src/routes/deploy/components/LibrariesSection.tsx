import type { LibraryBinding } from '@ignite/api';
import PointerValue from './PointerValue';
import { useAppDispatch, useAppSelector } from '../../../store';
import { setLibraries } from '../../../store/features/deployments/deployDraftSlice';
import { eligiblePointerSteps } from '../pointerEligibility';

export default function LibrariesSection({ stepId, names }: { stepId: string; names: string[] }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const bindings = draft.deployExtras[stepId]?.libraries ?? {};
  const eligible = eligiblePointerSteps(draft, stepId);
  const change = (name: string, value: string | { $ref: { kind: 'step'; stepId: string } } | undefined) => {
    const next = { ...bindings };
    if (!value) delete next[name];
    else if (typeof value === 'string') next[name] = { kind: 'address', address: value as `0x${string}` };
    else next[name] = { kind: 'step', stepId: value.$ref.stepId };
    dispatch(setLibraries({ stepId, libraries: Object.keys(next).length ? next : undefined }));
  };
  if (!names.length) return null;
  return (
    <section className="grid gap-3">
      <div><h4 className="font-medium">Libraries</h4><p className="text-xs text-muted">Link each library to an address or another deployment step.</p></div>
      {names.map((name) => {
        const binding: LibraryBinding | undefined = bindings[name];
        const value = binding?.kind === 'step' ? { $ref: { kind: 'step' as const, stepId: binding.stepId } } : binding?.address;
        return (
          <div key={name} className="grid gap-2">
            <span className="text-sm font-medium">{name}</span>
            <PointerValue value={value} eligibleSteps={eligible} onChange={(next) => change(name, next)} />
            {binding?.kind !== 'step' && <input className="input-glass" placeholder="0x… library address" value={binding?.address ?? ''} onChange={(event) => change(name, event.target.value || undefined)} />}
          </div>
        );
      })}
    </section>
  );
}
