import { useEffect, useState } from 'react';
import type { ArtifactData } from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import {
  setArg,
  setChainArgOverride,
  setGasOverride,
  setGasOverridePerChain,
  setValue,
} from '../../../store/features/deployments/deployDraftSlice';
import AbiArgField, { type AbiInput } from '../components/AbiArgField';
import AdvancedStepSection from '../components/AdvancedStepSection';
import ConstructorArgsForm from '../../../components/ConstructorArgsForm';

export default function ArgumentsStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chainInfo = useAppSelector((state) => state.chains.chains);
  const [artifactData, setArtifactData] = useState<
    Record<string, ArtifactData>
  >({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    draft.contracts.forEach((contract) => {
      void apiClient
        .request('getArtifactData', {
          body: {
            pathOrUrl: contract.repoPathOrUrl,
            pluginId: contract.frameworkId,
            artifactPath: contract.artifactPath,
          },
        })
        .then((response) => {
          if (!('data' in response)) throw new Error(response.message);
          if (!cancelled)
            setArtifactData((current) => ({
              ...current,
              [contract.id]: response.data,
            }));
        })
        .catch((error) => {
          if (!cancelled)
            setErrors((current) => ({
              ...current,
              [contract.id]:
                error instanceof Error ? error.message : String(error),
            }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [draft.contracts]);

  return (
    <section className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold">Arguments</h2>
        <p className="text-sm text-muted">
          Constructor arguments apply globally unless a chain override is set.
        </p>
      </div>
      {draft.steps.map((step) => {
        const contract = draft.contracts.find(
          (item) => item.id === step.contractId
        );
        const data = artifactData[step.contractId];
        const constructor = (
          data?.abi as
            | Array<{
                type?: string;
                inputs?: AbiInput[];
                stateMutability?: string;
              }>
            | undefined
        )?.find((entry) => entry.type === 'constructor');
        return (
          <article key={step.id} className="card-milky p-4 grid gap-4">
            <header>
              <h3 className="font-semibold">
                {contract?.contractName ?? step.contractId}
              </h3>
              <span className="mono-data text-muted">
                {contract?.sourcePath}
              </span>
            </header>
            {errors[step.contractId] && (
              <p className="text-sm text-err">{errors[step.contractId]}</p>
            )}
            {!data && !errors[step.contractId] && (
              <p className="text-sm text-muted">Loading ABI…</p>
            )}
            <ConstructorArgsForm
              abi={data?.abi as Array<{ type?: string; inputs?: AbiInput[] }> | undefined}
              value={step.args ?? {}}
              onChange={(args) => {
                Object.entries(args).forEach(([key, value]) =>
                  dispatch(setArg({ stepId: step.id, key, value }))
                );
              }}
            />
            {(constructor?.inputs ?? []).map((input, index) => {
              const key = input.name || `arg${index}`;
              return (
                <div key={key} className="grid gap-2">
                  {draft.chains.length > 1 && (
                    <details className="text-xs">
                      <summary className="text-muted cursor-pointer">
                        Per-chain override
                      </summary>
                      <div className="grid gap-2 mt-2 pl-3">
                        {draft.chains.map((chainId) => (
                          <div key={chainId} className="grid gap-1">
                            <span className="font-medium">
                              {chainInfo.find(
                                (item) => item.chainId === chainId
                              )?.name ?? chainId}
                            </span>
                            <AbiArgField
                              input={input}
                              fieldKey={key}
                              value={
                                step.argsPerChain?.[String(chainId)]?.[key]
                              }
                              onChange={(value) =>
                                dispatch(
                                  setChainArgOverride({
                                    stepId: step.id,
                                    chainId,
                                    key,
                                    value,
                                  })
                                )
                              }
                            />
                            {step.argsPerChain?.[String(chainId)]?.[key] !==
                              undefined && (
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary-borderless justify-self-start"
                                onClick={() =>
                                  dispatch(
                                    setChainArgOverride({
                                      stepId: step.id,
                                      chainId,
                                      key,
                                      value: undefined,
                                    })
                                  )
                                }
                              >
                                Clear override
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
            <AdvancedStepSection>
              {constructor?.stateMutability === 'payable' && (
                <label className="grid gap-1">
                  <span className="eyebrow">
                    Value sent with the deployment (native units)
                  </span>
                  <span className="text-xs text-muted">
                    The constructor is payable; this amount of the native
                    currency is attached to the deploy transaction on every
                    chain.
                  </span>
                  <input
                    className="input-glass"
                    value={step.value ?? ''}
                    placeholder="0.0"
                    onChange={(event) =>
                      dispatch(
                        setValue({
                          stepId: step.id,
                          value: event.target.value || undefined,
                        })
                      )
                    }
                  />
                </label>
              )}
              <div className="grid grid-cols-3 gap-2">
                {(
                  ['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const
                ).map((key) => (
                  <label key={key} className="grid gap-1">
                    <span className="eyebrow">
                      {key === 'gasLimit'
                        ? 'Gas limit'
                        : key === 'maxFeePerGas'
                          ? 'Max fee (gwei)'
                          : 'Priority fee (gwei)'}
                    </span>
                    <input
                      className="input-glass"
                      value={step.gasOverrides?.[key] ?? ''}
                      placeholder="auto"
                      onChange={(event) =>
                        dispatch(
                          setGasOverride({
                            stepId: step.id,
                            key,
                            value: event.target.value || undefined,
                          })
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              {draft.chains.length > 1 && (
                <details className="text-xs">
                  <summary className="text-muted cursor-pointer">
                    Per-chain gas overrides
                  </summary>
                  <div className="grid gap-3 mt-2">
                    {draft.chains.map((chainId) => (
                      <div key={chainId} className="card-milky p-3">
                        <div className="font-medium mb-2">
                          {chainInfo.find((item) => item.chainId === chainId)
                            ?.name ?? chainId}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {(
                            [
                              'gasLimit',
                              'maxFeePerGas',
                              'maxPriorityFeePerGas',
                            ] as const
                          ).map((key) => (
                            <label key={key} className="grid gap-1">
                              <span className="eyebrow">{key}</span>
                              <input
                                className="input-glass"
                                value={
                                  step.gasOverridesPerChain?.[
                                    String(chainId)
                                  ]?.[key] ?? ''
                                }
                                placeholder="Use global"
                                onChange={(event) =>
                                  dispatch(
                                    setGasOverridePerChain({
                                      stepId: step.id,
                                      chainId,
                                      key,
                                      value: event.target.value || undefined,
                                    })
                                  )
                                }
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </AdvancedStepSection>
          </article>
        );
      })}
    </section>
  );
}
