import { useEffect, useState } from 'react';
import { keccak256, stringToHex } from 'viem';
import type { DeploymentTypeInfo } from '@ignite/api';
import { ApiError } from '@ignite/api/client';
import Select from '../../../components/Select';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import {
  setPluginParams,
  setSalt,
  setSaltPerChain,
  setStrategy,
  storePrepared,
} from '../../../store/features/deployments/deployDraftSlice';
import { draftToPlanFragment } from '../planFromDraft';
import { replaceIdsForDisplay } from '../../../utils/displayText';
import { partitionDeterministicChains } from '../pointerEligibility';

export function apiErrorMessage(reason: unknown): string {
  return reason instanceof ApiError
    ? (reason.body.message ?? reason.message)
    : reason instanceof Error
      ? reason.message
      : String(reason);
}

export default function StrategySection({ stepId }: { stepId: string }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const extras = draft.deployExtras[stepId];
  const planStep = draft.steps.find((step) => step.id === stepId);
  const stepName =
    planStep?.kind === 'deploy'
      ? draft.contracts.find((contract) => contract.id === planStep.contractId)
          ?.contractName
      : planStep?.signature
        ? `Call ${planStep.signature}`
        : undefined;
  const strategy = extras?.strategy ?? { kind: 'create' as const };
  const { staticChains, dynamicChains } = partitionDeterministicChains(
    draft,
    stepId
  );
  const [types, setTypes] = useState<DeploymentTypeInfo[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    void apiClient
      .request('listDeploymentTypes', {})
      .then((response) => {
        if ('data' in response) setTypes(response.data.deploymentTypes);
      })
      .catch(() => undefined);
  }, []);
  const selected =
    strategy.kind === 'plugin' ? `plugin:${strategy.pluginId}` : strategy.kind;
  const selectStrategy = (value: string) => {
    if (value === 'create')
      dispatch(setStrategy({ stepId, strategy: { kind: 'create' } }));
    else if (value === 'create2')
      dispatch(setStrategy({ stepId, strategy: { kind: 'create2' } }));
    else
      dispatch(
        setStrategy({
          stepId,
          strategy: { kind: 'plugin', pluginId: value.slice('plugin:'.length) },
        })
      );
  };
  const prepare = async () => {
    setError(undefined);
    setLoading(true);
    try {
      const fragment = draftToPlanFragment(draft, chains);
      const response = await apiClient.request('prepareDeploymentStep', {
        body: {
          contracts: fragment.contracts,
          steps: fragment.steps,
          stepId,
          chainIds: staticChains,
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      dispatch(storePrepared({ stepId, chains: response.data.chains }));
    } catch (reason) {
      setError(apiErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  };
  const plugin =
    strategy.kind === 'plugin'
      ? types.find((item) => item.pluginId === strategy.pluginId)
      : undefined;
  const dynamicChainNames = dynamicChains.map(
    (chainId) =>
      chains.find((chain) => chain.chainId === chainId)?.name ??
      `Chain ${chainId}`
  );
  const staticPrepared = Object.entries(extras?.prepared ?? {}).filter(
    ([chainId]) => staticChains.includes(Number(chainId))
  );
  return (
    <section className="grid gap-3">
      <label className="grid gap-1">
        <span className="eyebrow">Deployment strategy</span>
        <Select
          value={selected}
          requireSelection
          options={[
            { value: 'create', label: 'Create' },
            { value: 'create2', label: 'Create2' },
            ...types.map((item) => ({
              value: `plugin:${item.pluginId}`,
              label: item.label,
            })),
          ]}
          onValueChange={selectStrategy}
        />
      </label>
      {strategy.kind === 'create2' && (
        <>
          <label className="grid gap-1">
            <span className="eyebrow">Salt</span>
            <div className="flex gap-2">
              <input
                className="input-glass"
                value={strategy.salt ?? ''}
                placeholder="0x… (32 bytes)"
                onChange={(event) =>
                  dispatch(
                    setSalt({
                      stepId,
                      salt: (event.target.value || undefined) as
                        `0x${string}` | undefined,
                    })
                  )
                }
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  dispatch(
                    setSalt({
                      stepId,
                      salt: keccak256(stringToHex(strategy.salt ?? '')),
                    })
                  )
                }
              >
                Text → keccak
              </button>
            </div>
          </label>
          {draft.chains.length > 1 && (
            <details className="text-xs">
              <summary className="text-muted cursor-pointer">
                Per-chain salt
              </summary>
              <div className="grid gap-3 mt-2">
                {draft.chains.map((chainId) => (
                  <label key={chainId} className="card-milky p-3 grid gap-1">
                    <span className="font-medium">
                      {chains.find((chain) => chain.chainId === chainId)
                        ?.name ?? chainId}
                    </span>
                    <input
                      className="input-glass"
                      value={strategy.saltPerChain?.[String(chainId)] ?? ''}
                      placeholder="Use global salt"
                      onChange={(event) =>
                        dispatch(
                          setSaltPerChain({
                            stepId,
                            chainId,
                            salt: (event.target.value || undefined) as
                              `0x${string}` | undefined,
                          })
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {plugin?.params.map((field) => {
        const value =
          strategy.kind === 'plugin' ? strategy.params?.[field.key] : undefined;
        const change = (next: unknown) =>
          dispatch(
            setPluginParams({
              stepId,
              params: {
                ...(strategy.kind === 'plugin' ? strategy.params : {}),
                [field.key]: next,
              },
            })
          );
        return (
          <label key={field.key} className="grid gap-1">
            <span className="eyebrow">{field.label}</span>
            {field.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => change(event.target.checked)}
              />
            ) : field.type === 'select' ? (
              <Select
                value={typeof value === 'string' ? value : undefined}
                options={field.options ?? []}
                onValueChange={change}
              />
            ) : (
              <input
                className="input-glass"
                value={
                  typeof value === 'string' || typeof value === 'number'
                    ? String(value)
                    : ''
                }
                onChange={(event) =>
                  change(
                    field.type === 'number'
                      ? Number(event.target.value)
                      : event.target.value
                  )
                }
              />
            )}
          </label>
        );
      })}
      {strategy.kind !== 'create' && staticChains.length > 0 && (
        <div className="flex gap-2 items-center">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void prepare()}
          >
            {loading
              ? 'Preparing…'
              : staticPrepared.length > 0
                ? 'Re-mine'
                : strategy.kind === 'create2'
                  ? 'Predict addresses'
                  : 'Mine'}
          </button>
          {extras?.needsPrepare && (
            <span className="chip chip-warn">needs re-mine</span>
          )}
        </div>
      )}
      {strategy.kind !== 'create' && dynamicChains.length > 0 && (
        <p className="text-xs text-muted">
          Salt is mined during the run against live addresses on:{' '}
          {dynamicChainNames.join(', ')}. Flags and a provisional address appear
          in validation.
        </p>
      )}
      {error && (
        <p className="text-sm text-err">
          {replaceIdsForDisplay(error, stepName ? { [stepId]: stepName } : {})}
        </p>
      )}
      {staticPrepared.map(([chainId, result]) => (
          <p key={chainId} className="text-xs mono-data">
            {chainId}: {result.predictedAddress}
          </p>
        ))}
    </section>
  );
}
