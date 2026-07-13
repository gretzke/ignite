// Deployment-owned reconciliation for the queue's durable crash window.
// The run record is authoritative; queue tasks are only a derived work list.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTransaction, type Hex } from 'viem';
import { FileSystem } from '../filesystem/FileSystem.js';
import { RunStore } from './RunStore.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { getLogger } from '../utils/logger.js';
import { RpcStore } from '../chains/RpcStore.js';
import { decomposeCreationCalldata } from './create2.js';
import { linkBytecode } from './linking.js';

export function wireVerificationReconciliation(queue: VerificationQueue): void {
  queue.reconcileRuns = async () => {
    const base = FileSystem.getInstance().getIgniteHome();
    let profiles: string[] = [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profiles dir within ~/.ignite
    try { profiles = (await fs.readdir(path.join(base, 'profiles'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return; }
    const runs = new RunStore();
    const rpcStore = new RpcStore();
    for (const profileId of profiles) {
      const listed = await runs.list(profileId);
      for (const summary of listed.runs) {
        const run = await runs.get(profileId, summary.id);
        if (!run) continue;
        for (const [chainKey, lane] of Object.entries(run.lanes)) {
          if (!run.explorerTargets?.[chainKey]?.length) continue;
          for (const step of lane.steps.filter((item) => item.status === 'confirmed' && item.address)) {
            const planStep = run.plan.steps.find((item) => item.id === step.stepId);
            const attempt = step.attempts.findLast((item) => item.txHash);
            const input = planStep?.kind === 'deploy' ? run.inputs[planStep.contractId] : undefined;
            if (!planStep || planStep.kind !== 'deploy' || !attempt?.txHash || !attempt.expected || !input || !step.address) continue;
            const rpc = run.rpcSelection[chainKey];
            if (!rpc) continue;
            let data: Hex | undefined;
            try {
              const endpoint = (await rpcStore.list(Number(chainKey))).find((item) => item.id === rpc.endpointId);
              if (endpoint) {
                const response = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [attempt.txHash] }) });
                const json = await response.json() as { result?: { input?: string } };
                if (typeof json.result?.input === 'string') data = json.result.input as Hex;
              }
            } catch { /* raw signed transaction fallback below */ }
            if (!data && attempt.rawTx) try { data = parseTransaction(attempt.rawTx).data as Hex | undefined; } catch { /* skip */ }
            if (!data) continue;
            const linked = input.creationCodeLinkReferences
              ? linkBytecode(input.creationBytecode, input.creationCodeLinkReferences, attempt.expected.libraries ?? {})
              : input.creationBytecode as Hex;
            const strategy = !planStep.strategy || planStep.strategy.kind === 'create' ? 'create' : 'create2';
            const decomposition = decomposeCreationCalldata(data, linked, strategy);
            if (!decomposition) {
              getLogger().warn(`verification reconciliation skipped ${attempt.txHash}: transaction data unavailable or calldata mismatch`);
              continue;
            }
            await queue.enqueueForConfirmedStep(profileId, run, Number(chainKey), step.stepId, planStep.contractId, step.address, attempt.txHash, decomposition.constructorData, attempt.expected.libraries);
          }
        }
      }
    }
  };
}
