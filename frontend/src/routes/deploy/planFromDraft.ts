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

function stepFromDraft(
  step: DraftStep,
  draft: DeployDraftState,
  currencies: Map<number, number>
): Step {
  const decimalsByChain = draft.chains.map((chainId) => {
    const decimals = currencies.get(chainId);
    if (decimals === undefined)
      throw new Error(`Missing currency metadata for chain ${chainId}`);
    return decimals;
  });
  const sameDecimals = new Set(decimalsByChain).size <= 1;
  const valuePerChain: Record<string, string> = {};
  let value: string | undefined;
  if (step.value?.trim()) {
    if (sameDecimals) {
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
    const decimals = currencies.get(Number(chainId));
    if (decimals === undefined)
      throw new Error(`Missing currency metadata for chain ${chainId}`);
    valuePerChain[chainId] = parseUnitsDecimal(humanValue, decimals);
  }
  const gasOverridesPerChain = Object.fromEntries(
    Object.entries(step.gasOverridesPerChain ?? {})
      .map(([chainId, gas]) => [chainId, gasFromDraft(gas)])
      .filter((entry): entry is [string, GasOverrides] => Boolean(entry[1]))
  );
  const common = {
    ...(cleanRecord(step.args) ? { args: { ...step.args } } : {}),
    ...(cleanRecord(step.argsPerChain)
      ? {
          argsPerChain: Object.fromEntries(
            Object.entries(step.argsPerChain ?? {}).map(([chainId, args]) => [
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
  } as Step;
}

export function draftToPlanFragment(
  draft: DeployDraftState,
  chainInfo: ChainInfo[]
): Pick<DeploymentPlan, 'contracts' | 'steps'> {
  const currencies = new Map(
    chainInfo.map((chain) => [chain.chainId, chain.nativeCurrency.decimals])
  );
  for (const chainId of draft.chains) {
    if (!currencies.has(chainId))
      throw new Error(`Missing currency metadata for chain ${chainId}`);
  }
  return {
    contracts: draft.contracts.map((contract) => ({ ...contract })),
    steps: draft.steps.map((step) => stepFromDraft(step, draft, currencies)),
  };
}

export function planFromDraft(
  draft: DeployDraftState,
  chainInfo: ChainInfo[]
): DeploymentPlan {
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
