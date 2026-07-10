import type { ChainInfo, DeploymentPlan, GasOverrides } from '@ignite/api';
import type { DeployDraftState } from '../../store/features/deployments/types';

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

export function planFromDraft(
  draft: DeployDraftState,
  chainInfo: ChainInfo[]
): DeploymentPlan {
  const currencies = new Map(
    chainInfo.map((chain) => [chain.chainId, chain.nativeCurrency.decimals])
  );
  return {
    schemaVersion: 1,
    contracts: draft.contracts.map((contract) => ({ ...contract })),
    chains: [...draft.chains],
    signers: {
      ...(draft.signers.global ? { global: { ...draft.signers.global } } : {}),
      ...(draft.signers.perChain
        ? { perChain: { ...draft.signers.perChain } }
        : {}),
    },
    steps: draft.steps.map((step) => {
      const decimalsByChain = draft.chains.map(
        (chainId) => currencies.get(chainId) ?? 18
      );
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
      for (const [chainId, humanValue] of Object.entries(
        step.valuePerChain ?? {}
      )) {
        const decimals = currencies.get(Number(chainId)) ?? 18;
        valuePerChain[chainId] = parseUnitsDecimal(humanValue, decimals);
      }
      const gasOverridesPerChain = Object.fromEntries(
        Object.entries(step.gasOverridesPerChain ?? {})
          .map(([chainId, gas]) => [chainId, gasFromDraft(gas)])
          .filter((entry): entry is [string, GasOverrides] => Boolean(entry[1]))
      );
      return {
        id: step.id,
        kind: 'deploy' as const,
        contractId: step.contractId,
        ...(cleanRecord(step.args) ? { args: { ...step.args } } : {}),
        ...(cleanRecord(step.argsPerChain)
          ? {
              argsPerChain: Object.fromEntries(
                Object.entries(step.argsPerChain ?? {}).map(
                  ([chainId, args]) => [chainId, { ...args }]
                )
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
    }),
  };
}
