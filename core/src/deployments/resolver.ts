// Canonical deployment-plan resolution. Validation and execution share these
// rules so a per-chain preview cannot diverge from the transaction submitted.
import { isAddress, type AbiParameter } from 'viem';
import type {
  ArgValues,
  DeploymentPlan,
  DeployStep,
  GasOverrides,
  SignerRef,
  Step,
} from '@ignite/api';
import { ErrorCodes, IgniteError } from '../types/errors.js';

export function argKeysForAbi(abiInputs: { name?: string }[]): string[] {
  return abiInputs.map((input, index) => input.name || `arg${index}`);
}

export function mergeArgs(step: DeployStep, chainId: number): ArgValues {
  return {
    ...(step.args ?? {}),
    ...(step.argsPerChain?.[String(chainId)] ?? {}),
  };
}

export function missingArgKeys(
  abiInputs: { name?: string }[],
  merged: ArgValues
): string[] {
  return argKeysForAbi(abiInputs).filter(
    (key) => !Object.prototype.hasOwnProperty.call(merged, key)
  );
}

export function mergeGas(step: DeployStep, chainId: number): GasOverrides {
  return {
    ...(step.gasOverrides ?? {}),
    ...(step.gasOverridesPerChain?.[String(chainId)] ?? {}),
  };
}

export function effectiveValue(step: DeployStep, chainId: number): bigint {
  return BigInt(step.valuePerChain?.[String(chainId)] ?? step.value ?? '0');
}

export function resolveSigner(
  plan: DeploymentPlan,
  step: Step,
  chainId: number
): SignerRef | undefined {
  const key = String(chainId);
  return (
    step.signerOverride?.perChain?.[key] ??
    step.signerOverride?.global ??
    plan.signers.perChain?.[key] ??
    plan.signers.global
  );
}

export function toConstructorArgs(
  abiInputs: AbiParameter[],
  merged: ArgValues
): unknown[] {
  return abiInputs.map((input, index) => {
    const key = input.name || `arg${index}`;
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      throw argError(key, 'is required');
    }
    return coerceAbiValue(input, merged[key], key);
  });
}

function coerceAbiValue(
  parameter: AbiParameter,
  value: unknown,
  field: string
): unknown {
  const arrayMatch = parameter.type.match(/^(.*)\[([0-9]*)\]$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) {
      throw argError(field, 'must be an array');
    }
    const [, elementType, fixedLength] = arrayMatch;
    if (fixedLength && value.length !== Number(fixedLength)) {
      throw argError(field, `must contain exactly ${fixedLength} items`);
    }
    return value.map((item, index) =>
      coerceAbiValue(
        { ...parameter, type: elementType },
        item,
        `${field}[${index}]`
      )
    );
  }

  if (parameter.type === 'tuple') {
    return coerceTuple(parameter, value, field);
  }

  if (/^u?int(?:[0-9]+)?$/.test(parameter.type)) {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw argError(field, 'must be a decimal integer string');
    }
    if (parameter.type.startsWith('uint') && value.startsWith('-')) {
      throw argError(field, 'must not be negative');
    }
    try {
      return BigInt(value);
    } catch {
      throw argError(field, 'must be a decimal integer string');
    }
  }

  if (parameter.type === 'address') {
    if (typeof value !== 'string' || !isAddress(value)) {
      throw argError(field, 'must be a valid address');
    }
    return value;
  }

  if (parameter.type === 'bool') {
    if (typeof value !== 'boolean') throw argError(field, 'must be a boolean');
    return value;
  }

  if (parameter.type === 'string') {
    if (typeof value !== 'string') throw argError(field, 'must be a string');
    return value;
  }

  if (
    parameter.type === 'bytes' ||
    /^bytes(?:[1-9]|[12][0-9]|3[0-2])$/.test(parameter.type)
  ) {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      throw argError(field, 'must be hex data');
    }
    const fixedBytes = parameter.type.match(/^bytes([0-9]+)$/)?.[1];
    if (fixedBytes && value.length !== 2 + Number(fixedBytes) * 2) {
      throw argError(field, `must be exactly ${fixedBytes} bytes`);
    }
    return value;
  }

  throw argError(field, `uses unsupported ABI type ${parameter.type}`);
}

function coerceTuple(
  parameter: AbiParameter,
  value: unknown,
  field: string
): unknown {
  const components =
    'components' in parameter ? (parameter.components ?? []) : [];
  if (Array.isArray(value)) {
    if (value.length !== components.length) {
      throw argError(field, `must contain exactly ${components.length} fields`);
    }
    return components.map((component, index) =>
      coerceAbiValue(
        component,
        value[index],
        `${field}.${component.name || `arg${index}`}`
      )
    );
  }
  if (typeof value !== 'object' || value === null) {
    throw argError(field, 'must be a tuple object or array');
  }

  const record = value as Record<string, unknown>;
  const allUnnamed = components.every((component) => !component.name);
  const result: Record<string, unknown> = {};
  const positional: unknown[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const key = component.name || `arg${index}`;
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw argError(`${field}.${key}`, 'is required');
    }
    const coerced = coerceAbiValue(component, record[key], `${field}.${key}`);
    if (allUnnamed) positional.push(coerced);
    else result[key] = coerced;
  }
  return allUnnamed ? positional : result;
}

function argError(field: string, detail: string): IgniteError {
  return new IgniteError(
    `Constructor argument ${field} ${detail}`,
    ErrorCodes.ARG_TYPE_MISMATCH,
    { field }
  );
}
