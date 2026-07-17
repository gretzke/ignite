import type {
  ChainInfo,
  DeploymentPlan,
  GasOverrides,
  Step,
} from '@ignite/api';
import type {
  DeployDraftState,
  DraftDeployStep,
  DraftStep,
} from '../../store/features/deployments/types';

export function parseUnitsDecimal(value: string, decimals: number): string {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Value has more than ${decimals} decimal places`);
  }
  const units = `${whole}${fraction.padEnd(decimals, '0')}`.replace(
    /^0+(?=\d)/,
    ''
  );
  return units || '0';
}

function cleanRecord<T extends object>(value: T | undefined): T | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

function gasFromDraft(gas: GasOverrides | undefined): GasOverrides | undefined {
  if (!gas) return undefined;
  const result: GasOverrides = {};
  if (gas.gasLimit?.trim()) result.gasLimit = gas.gasLimit.trim();
  if (gas.maxFeePerGas?.trim())
    result.maxFeePerGas = parseUnitsDecimal(gas.maxFeePerGas, 9);
  if (gas.maxPriorityFeePerGas?.trim())
    result.maxPriorityFeePerGas = parseUnitsDecimal(
      gas.maxPriorityFeePerGas,
      9
    );
  return cleanRecord(result);
}

function isEncoded(value: unknown): value is { $encode: { contractId: string; fn: string; args?: Record<string, unknown> } } {
  return Boolean(value && typeof value === 'object' && '$encode' in value);
}

function isCompleteEncoded(value: unknown): value is { $encode: { contractId: string; fn: string; args?: Record<string, unknown> } } {
  return isEncoded(value) && typeof value.$encode.contractId === 'string' && value.$encode.contractId.length > 0 && typeof value.$encode.fn === 'string' && value.$encode.fn.length > 0;
}

// Core deliberately treats wrapper argsPerChain atomically. The draft stays
// sparse for pleasant per-chain editing, then this boundary emits every
// constructor field and every encoded initializer argument for each override.
function materializedWrapperArgs(step: DraftDeployStep): Record<string, Record<string, unknown>> | undefined {
  if (!step.wraps || !step.argsPerChain) return step.argsPerChain;
  return Object.fromEntries(Object.entries(step.argsPerChain).map(([chainId, override]) => {
    const args: Record<string, unknown> = { ...(step.args ?? {}), ...override };
    for (const [key, value] of Object.entries(override)) {
      const global = step.args?.[key];
      // An argsPerChain override is atomic in the engine. Only combine an
      // initializer's sparse draft args when both halves describe the same
      // call; never put an old override's args on a new global function.
      if (isEncoded(global) && isEncoded(value) && !isCompleteEncoded(value)) {
        args[key] = global;
      } else if (isCompleteEncoded(global) && isCompleteEncoded(value) && global.$encode.fn === value.$encode.fn) {
        args[key] = {
          $encode: {
            ...global.$encode,
            ...value.$encode,
            args: { ...(global.$encode.args ?? {}), ...(value.$encode.args ?? {}) },
          },
        };
      }
    }
    return [chainId, args];
  }));
}

function stepFromDraft(
  step: DraftStep,
  draft: DeployDraftState,
  currencies: Map<number, number>
): Step {
  // Decimals are resolved lazily: only steps that carry a native value need
  // currency metadata, so a value-less draft (e.g. mining a hook salt) works
  // even before the selected chains' metadata has loaded.
  const decimalsFor = (chainId: number): number => {
    const decimals = currencies.get(chainId);
    if (decimals === undefined)
      throw new Error(`Missing currency metadata for chain ${chainId}`);
    return decimals;
  };
  const valuePerChain: Record<string, string> = {};
  let value: string | undefined;
  if (step.value?.trim()) {
    const decimalsByChain = draft.chains.map(decimalsFor);
    if (new Set(decimalsByChain).size <= 1) {
      value = parseUnitsDecimal(step.value, decimalsByChain[0] ?? 18);
    } else {
      draft.chains.forEach((chainId, index) => {
        valuePerChain[String(chainId)] = parseUnitsDecimal(
          step.value!,
          decimalsByChain[index]
        );
      });
    }
  }
  for (const [chainId, humanValue] of Object.entries(step.valuePerChain ?? {})) {
    valuePerChain[chainId] = parseUnitsDecimal(
      humanValue,
      decimalsFor(Number(chainId))
    );
  }
  const gasOverridesPerChain = Object.fromEntries(
    Object.entries(step.gasOverridesPerChain ?? {})
      .map(([chainId, gas]) => [chainId, gasFromDraft(gas)])
      .filter((entry): entry is [string, GasOverrides] => Boolean(entry[1]))
  );
  const argsPerChain = step.kind === 'deploy' ? materializedWrapperArgs(step) : step.argsPerChain;
  const common = {
    ...(cleanRecord(step.args) ? { args: { ...step.args } } : {}),
    ...(cleanRecord(argsPerChain)
      ? {
          argsPerChain: Object.fromEntries(
            Object.entries(argsPerChain ?? {}).map(([chainId, args]) => [
              chainId,
              { ...args },
            ])
          ),
        }
      : {}),
    ...(value !== undefined ? { value } : {}),
    ...(Object.keys(valuePerChain).length ? { valuePerChain } : {}),
    ...(gasFromDraft(step.gasOverrides)
      ? { gasOverrides: gasFromDraft(step.gasOverrides) }
      : {}),
    ...(Object.keys(gasOverridesPerChain).length
      ? { gasOverridesPerChain }
      : {}),
    ...(step.signerOverride
      ? {
          signerOverride: {
            ...(step.signerOverride.global
              ? { global: { ...step.signerOverride.global } }
              : {}),
            ...(step.signerOverride.perChain
              ? {
                  perChain: Object.fromEntries(
                    Object.entries(step.signerOverride.perChain).map(
                      ([chainId, signer]) => [chainId, { ...signer }]
                    )
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
  if (step.kind === 'call') {
    if (!step.target) throw new Error(`Call step ${step.id} needs a call target`);
    return {
      id: step.id,
      kind: 'call',
      target: { ...step.target },
      ...(step.targetPerChain
        ? { targetPerChain: { ...step.targetPerChain } }
        : {}),
      ...(step.signature ? { signature: step.signature } : {}),
      ...(step.payable ? { payable: true } : {}),
      ...common,
    };
  }
  return deployStepFromDraft(step, draft, common);
}

function deployStepFromDraft(
  step: DraftDeployStep,
  draft: DeployDraftState,
  common: Omit<Step, 'id' | 'kind'>
): Step {
  const extras = draft.deployExtras[step.id];
  const strategy = extras?.strategy;
  let strategyField: Step extends infer _Unused ? object : never = {};
  if (strategy?.kind === 'create2') {
    if (!strategy.salt) throw new Error(`Create2 step ${step.id} needs a salt`);
    strategyField = {
      strategy: {
        kind: 'create2',
        salt: strategy.salt,
        ...(strategy.saltPerChain ? { saltPerChain: { ...strategy.saltPerChain } } : {}),
        ...(extras.acknowledged ? { acknowledgeDeployed: { ...extras.acknowledged } } : {}),
      },
    };
  } else if (strategy?.kind === 'plugin') {
    const prepared = Object.fromEntries(
      Object.entries(extras.prepared ?? {}).map(([chainId, prepared]) => [
        chainId,
        {
          initcodeHash: prepared.initcodeHash,
          predictedAddress: prepared.predictedAddress,
        },
      ])
    );
    const salts = Object.fromEntries(
      Object.entries(extras.prepared ?? {}).map(([chainId, prepared]) => [
        chainId,
        prepared.salt,
      ])
    );
    const firstSalt = Object.values(salts)[0];
    strategyField = {
      strategy: {
        kind: 'plugin',
        pluginId: strategy.pluginId,
        ...(strategy.params ? { params: { ...strategy.params } } : {}),
        ...(firstSalt ? { salt: firstSalt } : {}),
        ...(Object.keys(salts).length ? { saltPerChain: salts } : {}),
        ...(Object.keys(prepared).length ? { prepared } : {}),
        ...(extras.acknowledged ? { acknowledgeDeployed: { ...extras.acknowledged } } : {}),
      },
    };
  }
  return {
    id: step.id,
    kind: 'deploy',
    contractId: step.contractId,
    ...common,
    ...strategyField,
    ...(extras?.libraries ? { libraries: { ...extras.libraries } } : {}),
    ...(extras?.librariesPerChain
      ? { librariesPerChain: { ...extras.librariesPerChain } }
      : {}),
    ...(step.wraps ? { wraps: { ...step.wraps } } : {}),
    ...(step.acknowledgeUninitialized ? { acknowledgeUninitialized: true } : {}),
    ...(step.acknowledgeUnverifiedBytecode ? { acknowledgeUnverifiedBytecode: true } : {}),
  } as Step;
}

export function draftToPlanFragment(
  draft: DeployDraftState,
  chainInfo: ChainInfo[]
): Pick<DeploymentPlan, 'contracts' | 'steps'> {
  const currencies = new Map(
    chainInfo.map((chain) => [chain.chainId, chain.nativeCurrency.decimals])
  );
  return {
    contracts: draft.contracts.map((contract) => ({ ...contract })),
    steps: draft.steps.map((step) => stepFromDraft(step, draft, currencies)),
  };
}

export function planFromDraft(
  draft: DeployDraftState,
  chainInfo: ChainInfo[]
): DeploymentPlan {
  // The full plan (validate/launch) keeps the fail-fast: refusing to guess
  // decimals for any selected chain. The fragment path above stays lax so
  // value-less prepares work before chain metadata loads.
  const known = new Set(chainInfo.map((chain) => chain.chainId));
  for (const chainId of draft.chains) {
    if (!known.has(chainId))
      throw new Error(`Missing currency metadata for chain ${chainId}`);
  }
  const fragment = draftToPlanFragment(draft, chainInfo);
  return {
    schemaVersion: 1,
    ...fragment,
    chains: [...draft.chains],
    signers: {
      ...(draft.signers.global ? { global: { ...draft.signers.global } } : {}),
      ...(draft.signers.perChain ? { perChain: { ...draft.signers.perChain } } : {}),
    },
  };
}
