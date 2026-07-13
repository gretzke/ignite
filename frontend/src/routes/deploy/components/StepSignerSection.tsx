import type { SignerCascade, SignerRef } from '@ignite/api';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import { setStepSigner } from '../../../store/features/deployments/deployDraftSlice';

function key(ref: SignerRef | undefined) {
  return ref ? `${ref.pluginId}:${ref.accountId}` : '__default__';
}

export default function StepSignerSection({ stepId }: { stepId: string }) {
  const dispatch = useAppDispatch();
  const override = useAppSelector((state) => state.deployDraft.steps.find((step) => step.id === stepId)?.signerOverride);
  const providers = useAppSelector((state) => state.signers.providers);
  const refs = providers.flatMap((provider) => provider.accounts.map((account) => ({
    value: `${provider.pluginId}:${account.id}`,
    label: `${provider.name} · ${account.label ?? account.address}`,
    ref: { pluginId: provider.pluginId, accountId: account.id, address: account.address } satisfies SignerRef,
  })));
  const setGlobal = (value: string) => {
    const next: SignerCascade = { ...(override ?? {}) };
    if (value === '__default__') delete next.global;
    else next.global = refs.find((item) => item.value === value)?.ref;
    dispatch(setStepSigner({ stepId, cascade: Object.keys(next).length ? next : undefined }));
  };
  return (
    <details className="border-t border-[var(--hairline)] pt-3">
      <summary className="text-sm cursor-pointer">Signer: {override?.global ? 'step override' : 'run default'}</summary>
      <div className="grid gap-2 mt-3">
        <span className="eyebrow">Step signer</span>
        <Select
          value={key(override?.global)}
          requireSelection
          options={[{ value: '__default__', label: 'Use run default' }, ...refs]}
          onValueChange={setGlobal}
        />
        <p className="text-xs text-muted">Per-chain signer overrides inherit from the run configuration unless set in the signer step.</p>
      </div>
    </details>
  );
}
