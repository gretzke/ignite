import type { DeploymentPlan, FrozenInputs, Hex } from '@ignite/api';
import { collectRefs } from './resolver.js';
import {
  ackIsFresh,
  buildSchedule,
  computeCreateAddresses,
  predictPlanAddresses,
  type ScheduleEntry,
} from './schedule.js';
import type { ForkRunner } from './forkContainer.js';

export interface SimulationOutcome {
  tier: 'simulateV1' | 'fork' | 'estimate';
  baseBlock?: number;
  perStep: Record<
    string,
    {
      gasUsed?: string;
      status: 'ok' | 'reverted' | 'skipped-existing' | 'unestimable';
      reason?: string;
    }
  >;
  warnings: string[];
  fallthrough: string[];
}

export interface SimClient {
  simulateBlocks?: (args: unknown) => Promise<unknown>;
  estimateGas(args: {
    account: Hex;
    to?: Hex;
    value: bigint;
    data: Hex;
  }): Promise<bigint>;
  getTransactionCount(args: {
    address: Hex;
    blockTag?: 'latest';
  }): Promise<number | bigint>;
  getBlockNumber(): Promise<number | bigint>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function simResults(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(simResults);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.calls))
    return record.calls.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object'
    );
  if (Array.isArray(record.blocks)) return record.blocks.flatMap(simResults);
  if (Array.isArray(record.results)) return record.results.flatMap(simResults);
  return [];
}

function resultStatus(result: Record<string, unknown> | undefined): {
  status: 'ok' | 'reverted';
  gasUsed?: string;
  reason?: string;
} {
  if (!result) return { status: 'ok' };
  const raw = String(
    result.status ?? result.success ?? 'success'
  ).toLowerCase();
  const reverted =
    raw === 'false' ||
    raw === 'reverted' ||
    raw === 'failure' ||
    raw === 'failed' ||
    result.error !== undefined;
  const gas = result.gasUsed ?? result.gas ?? result.gasEstimate;
  const reason =
    typeof result.reason === 'string'
      ? result.reason
      : typeof result.error === 'string'
        ? result.error
        : undefined;
  return {
    status: reverted ? 'reverted' : 'ok',
    ...(gas === undefined ? {} : { gasUsed: String(gas) }),
    ...(reason ? { reason } : {}),
  };
}

function dependsOnPlainCreate(
  plan: DeploymentPlan,
  entry: ScheduleEntry,
  chainId: number
): boolean {
  const step = plan.steps.find((item) => item.id === entry.stepId);
  if (!step) return false;
  return collectRefs(step, chainId).some((ref) => {
    const target = plan.steps.find((item) => item.id === ref.stepId);
    return (
      target?.kind === 'deploy' &&
      (!target.strategy || target.strategy.kind === 'create')
    );
  });
}

function initialEntries(
  schedule: ScheduleEntry[]
): SimulationOutcome['perStep'] {
  return Object.fromEntries(
    schedule
      .filter((entry) => entry.kind === 'existing')
      .map((entry) => [entry.stepId, { status: 'skipped-existing' as const }])
  );
}

function assertForkAddresses(
  schedule: ScheduleEntry[],
  receipts: Record<
    string,
    {
      gasUsed: string;
      status: 'ok' | 'reverted';
      reason?: string;
      createdAddress?: Hex;
    }
  >
): void {
  for (const entry of schedule) {
    if (entry.kind !== 'tx' || (!entry.predictedAddress && !entry.address))
      continue;
    const actual = receipts[entry.stepId]?.createdAddress;
    const expected = entry.predictedAddress ?? entry.address;
    if (actual && expected && actual.toLowerCase() !== expected.toLowerCase()) {
      const error = new Error(
        `Simulation address divergence for ${entry.stepId}: expected ${expected}, got ${actual}`
      );
      Object.assign(error, { code: 'SIMULATION_ADDRESS_DIVERGENCE' });
      throw error;
    }
  }
}

// The simulation owns the pre-pass so all three tiers see the exact same
// nonce-derived create addresses and acknowledged-existing omissions.
export async function simulateChain(args: {
  chainId: number;
  plan: DeploymentPlan;
  frozen: FrozenInputs;
  signers: Map<string, Hex>;
  client: SimClient;
  fork: ForkRunner | undefined;
}): Promise<SimulationOutcome> {
  const signerAddresses = [
    ...new Set(
      [...args.signers.values()].map((address) => address.toLowerCase() as Hex)
    ),
  ];
  const baseNonces = new Map<Hex, number>();
  await Promise.all(
    signerAddresses.map(async (address) => {
      baseNonces.set(
        address,
        asNumber(
          await args.client.getTransactionCount({ address, blockTag: 'latest' })
        )
      );
    })
  );
  // Acknowledged-existing create2 steps broadcast nothing, so they must not
  // consume a nonce in the create-address pre-pass (spec §5.0).
  const predictions = predictPlanAddresses(args.plan, args.frozen, args.chainId);
  const skipTx = new Set(
    args.plan.steps
      .filter(
        (step) =>
          step.kind === 'deploy' &&
          step.strategy &&
          step.strategy.kind !== 'create' &&
          predictions[step.id] !== undefined &&
          ackIsFresh(step.strategy, args.chainId, predictions[step.id])
      )
      .map((step) => step.id)
  );
  const createAddresses = computeCreateAddresses(
    args.plan,
    args.frozen,
    args.chainId,
    args.signers,
    baseNonces,
    skipTx
  );
  const schedule = buildSchedule(args.plan, args.frozen, args.chainId, {
    signers: args.signers,
    createAddresses,
  });
  const entries = initialEntries(schedule);
  const fallthrough: string[] = [];
  const warnings: string[] = [];
  const baseBlock = asNumber(await args.client.getBlockNumber());
  const txs = schedule.filter(
    (
      entry
    ): entry is ScheduleEntry & {
      kind: 'tx';
      from: Hex;
      data: Hex;
      value: bigint;
    } =>
      entry.kind === 'tx' &&
      Boolean(entry.from && entry.data && entry.value !== undefined)
  );

  if (args.client.simulateBlocks) {
    try {
      const nonce = new Map(baseNonces);
      const calls = txs.map((entry) => {
        const from = entry.from.toLowerCase() as Hex;
        const current = nonce.get(from) ?? 0;
        nonce.set(from, current + 1);
        return {
          // viem's simulateBlocks expects `account` (not raw `from`). The
          // `to` key must be OMITTED for contract creation: anvil rejects an
          // explicit null with "missing keys: [to]".
          account: entry.from,
          ...(entry.to ? { to: entry.to } : {}),
          data: entry.data,
          value: entry.value,
          nonce: BigInt(current),
        };
      });
      const results = simResults(
        await args.client.simulateBlocks({
          blocks: [{ calls }],
          validation: false,
        })
      );
      txs.forEach((entry, index) => {
        entries[entry.stepId] = resultStatus(results[index]);
      });
      return {
        tier: 'simulateV1',
        baseBlock,
        perStep: entries,
        warnings,
        fallthrough,
      };
    } catch (error) {
      // Tier 1 infrastructure/shape errors (method missing, RPCs like anvil
      // that cannot build creation calls, transport failures) mean "this
      // tier cannot judge the plan" — fall through with the reason recorded.
      // Only simulation RESULTS (reverts, address divergence) block.
      fallthrough.push(`SIMULATION_SIMULATEV1_UNAVAILABLE: ${message(error)}`);
    }
  } else {
    fallthrough.push(
      'SIMULATION_SIMULATEV1_UNAVAILABLE: RPC client does not support eth_simulateV1'
    );
  }

  if (args.fork) {
    try {
      const receipts = await args.fork.run(schedule);
      assertForkAddresses(schedule, receipts);
      for (const entry of schedule) {
        if (entry.kind === 'tx') {
          const receipt = receipts[entry.stepId];
          entries[entry.stepId] = receipt
            ? {
                status: receipt.status,
                gasUsed: receipt.gasUsed,
                ...(receipt.reason ? { reason: receipt.reason } : {}),
              }
            : { status: 'reverted', reason: 'Fork did not return a receipt' };
        }
      }
      return {
        tier: 'fork',
        baseBlock,
        perStep: entries,
        warnings,
        fallthrough,
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'SIMULATION_ADDRESS_DIVERGENCE')
        throw error;
      fallthrough.push(`SIMULATION_FORK_UNAVAILABLE: ${message(error)}`);
    }
  } else {
    fallthrough.push(
      'SIMULATION_FORK_UNAVAILABLE: Docker or foundry image is unavailable'
    );
  }

  const touched = new Set<string>();
  for (const entry of schedule) {
    if (entry.kind === 'existing') continue;
    const produced = (entry.address ?? entry.predictedAddress)?.toLowerCase();
    // A call whose target address is created or called by an EARLIER schedule
    // entry depends on sequence state; independent eth_estimateGas would run
    // against pre-sequence chain state and mis-report (e.g. "not owner" on the
    // second of two ownership transfers, or no code at a not-yet-deployed
    // create2 target). Tiers 1-2 simulate the sequence; tier 3 must be honest.
    const callTarget = !produced && entry.to ? entry.to.toLowerCase() : undefined;
    const sequenceDependent = callTarget !== undefined && touched.has(callTarget);
    if (produced) touched.add(produced);
    if (callTarget) touched.add(callTarget);
    if (
      !entry.from ||
      !entry.data ||
      entry.value === undefined ||
      sequenceDependent ||
      dependsOnPlainCreate(args.plan, entry, args.chainId)
    ) {
      entries[entry.stepId] = {
        status: 'unestimable',
        reason: 'SIMULATION_UNAVAILABLE_DEPENDENT',
      };
      warnings.push(
        `SIMULATION_UNAVAILABLE_DEPENDENT: ${entry.stepId} will resolve at execution`
      );
      continue;
    }
    try {
      const gas = await args.client.estimateGas({
        account: entry.from,
        ...(entry.to ? { to: entry.to } : {}),
        value: entry.value,
        data: entry.data,
      });
      entries[entry.stepId] = { status: 'ok', gasUsed: gas.toString() };
    } catch (error) {
      entries[entry.stepId] = { status: 'reverted', reason: message(error) };
    }
  }
  return {
    tier: 'estimate',
    baseBlock,
    perStep: entries,
    warnings,
    fallthrough,
  };
}
