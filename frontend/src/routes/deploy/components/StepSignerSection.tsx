import type { SignerCascade, SignerRef } from '@ignite/api';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import { setStepSigner } from '../../../store/features/deployments/deployDraftSlice';

function key(ref: SignerRef | undefined) {
  return ref ? `${ref.pluginId}:${ref.accountId}` : '__default__';
}

export default function StepSignerSection({ stepId }: { stepId: string }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const override = draft.steps.find(
    (step) => step.id === stepId
  )?.signerOverride;
  const providers = useAppSelector((state) => state.signers.providers);
  const refs = providers.flatMap((provider) =>
    provider.accounts.map((account) => ({
      value: `${provider.pluginId}:${account.id}`,
      label: `${provider.name} · ${account.label ?? account.address}`,
      ref: {
        pluginId: provider.pluginId,
        accountId: account.id,
        address: account.address,
      } satisfies SignerRef,
    }))
  );
  const setGlobal = (value: string) => {
    const next: SignerCascade = { ...(override ?? {}) };
    if (value === '__default__') delete next.global;
    else next.global = refs.find((item) => item.value === value)?.ref;
    dispatch(
      setStepSigner({
        stepId,
        cascade: Object.keys(next).length ? next : undefined,
      })
    );
  };
  const setPerChain = (chainId: number, value: string) => {
    const next: SignerCascade = { ...(override ?? {}) };
    const perChain = { ...(next.perChain ?? {}) };
    const chainKey = String(chainId);
    if (value === '__default__') delete perChain[chainKey];
    else {
      const signer = refs.find((item) => item.value === value)?.ref;
      if (signer) perChain[chainKey] = signer;
    }
    if (Object.keys(perChain).length) next.perChain = perChain;
    else delete next.perChain;
    dispatch(
      setStepSigner({
        stepId,
        cascade: Object.keys(next).length ? next : undefined,
      })
    );
  };
  const hasPerChain = Object.keys(override?.perChain ?? {}).length > 0;
  const label = hasPerChain
    ? override?.global
      ? 'step + per-chain override'
      : 'per-chain override'
    : override?.global
      ? 'step override'
      : 'run default';
  return (
    <details className="border-t border-[var(--hairline)] pt-3">
      <summary className="text-sm cursor-pointer">Signer: {label}</summary>
      <div className="grid gap-2 mt-3">
        <span className="eyebrow">Step signer</span>
        <Select
          value={key(override?.global)}
          requireSelection
          options={[
            { value: '__default__', label: 'Use run default' },
            ...refs,
          ]}
          onValueChange={setGlobal}
        />
        {draft.chains.length >= 2 && (
          <div className="grid gap-3 mt-1">
            {draft.chains.map((chainId) => (
              <div key={chainId} className="card-milky p-3 grid gap-2">
                <span className="font-medium">
                  {chains.find((chain) => chain.chainId === chainId)?.name ??
                    chainId}
                </span>
                <label className="grid gap-1">
                  <span className="eyebrow">Signer override</span>
                  <Select
                    value={key(override?.perChain?.[String(chainId)])}
                    requireSelection
                    options={[
                      { value: '__default__', label: 'Inherit' },
                      ...refs,
                    ]}
                    onValueChange={(value) => setPerChain(chainId, value)}
                  />
                </label>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted">
          Per-chain overrides take precedence over the step signer, then fall
          back to run configuration.
        </p>
      </div>
    </details>
  );
}
