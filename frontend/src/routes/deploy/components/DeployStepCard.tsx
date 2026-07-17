import { Loader2 } from 'lucide-react';
import type { ArtifactData } from '@ignite/api';
import type { DraftDeployStep } from '../../../store/features/deployments/types';
import { useAppDispatch, useAppSelector } from '../../../store';
import { setArg, setChainArgOverride, setGasOverride, setValue } from '../../../store/features/deployments/deployDraftSlice';
import AbiArgField, { type AbiInput } from './AbiArgField';
import AdvancedStepSection from './AdvancedStepSection';
import LibrariesSection from './LibrariesSection';
import StepSignerSection from './StepSignerSection';
import StrategySection from './StrategySection';
import { eligiblePointerSteps } from '../pointerEligibility';
import PerChainTransactionOverrides from './PerChainTransactionOverrides';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';

function libraryReferences(data: ArtifactData | undefined) {
  return Object.entries(data?.creationCodeLinkReferences ?? {}).flatMap(
    ([sourcePath, libraries]) =>
      Object.keys(libraries).map((name) => ({
        key: `${sourcePath}:${name}`,
        name,
        sourcePath,
      }))
  );
}

export default function DeployStepCard({ step, data, onMove }: { step: DraftDeployStep; data?: ArtifactData; onMove: (delta: number) => void }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const contract = draft.contracts.find((item) => item.id === step.contractId);
  if (contract?.origin === 'contract-type') return null; // contract-types plan phase 11
  const sourcePath = contract?.sourcePath;
  const inputs = ((data?.abi as Array<{ type?: string; inputs?: AbiInput[] }> | undefined)?.find((entry) => entry.type === 'constructor')?.inputs ?? []);
  const eligible = eligiblePointerSteps(draft, step.id);
  return <article className="card-milky p-4 grid gap-4">
    <header className="flex gap-2 items-start"><div className="flex-1"><h3 className="font-semibold">{contract?.contractName ?? decodeUrlEncodingForDisplay(step.contractId)}</h3><p className="mono-data text-muted">{sourcePath ? decodeUrlEncodingForDisplay(sourcePath) : undefined}</p></div><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step up" onClick={() => onMove(-1)}>↑</button><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step down" onClick={() => onMove(1)}>↓</button></header>
    <StrategySection stepId={step.id} />
    <LibrariesSection stepId={step.id} libraries={libraryReferences(data)} />
    <section className="grid gap-3"><h4 className="font-medium">Constructor arguments</h4>{!data && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading artifact…</p>}{inputs.map((input, index) => { const key = input.name || `arg${index}`; return <div key={key} className="grid gap-2"><AbiArgField input={input} fieldKey={key} value={step.args?.[key]} autoDefault eligibleSteps={eligible} onChange={(value) => dispatch(setArg({ stepId: step.id, key, value }))} />{draft.chains.length > 1 && <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain override</summary>{draft.chains.map((chainId) => <div key={chainId} className="mt-2"><AbiArgField input={input} fieldKey={key} value={step.argsPerChain?.[String(chainId)]?.[key]} eligibleSteps={eligible} onChange={(value) => dispatch(setChainArgOverride({ stepId: step.id, chainId, key, value }))} /></div>)}</details>}</div>; })}</section>
    <AdvancedStepSection>{(data?.abi as Array<{ type?: string; stateMutability?: string }> | undefined)?.find((entry) => entry.type === 'constructor')?.stateMutability === 'payable' && <label className="grid gap-1"><span className="eyebrow">Value (native units)</span><input className="input-glass" value={step.value ?? ''} onChange={(event) => dispatch(setValue({ stepId: step.id, value: event.target.value || undefined }))} /></label>}<div className="grid grid-cols-3 gap-2">{(['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map((key) => <label key={key} className="grid gap-1"><span className="eyebrow">{key}</span><input className="input-glass" value={step.gasOverrides?.[key] ?? ''} onChange={(event) => dispatch(setGasOverride({ stepId: step.id, key, value: event.target.value || undefined }))} /></label>)}</div><PerChainTransactionOverrides stepId={step.id} showValue={(data?.abi as Array<{ type?: string; stateMutability?: string }> | undefined)?.find((entry) => entry.type === 'constructor')?.stateMutability === 'payable'} /></AdvancedStepSection>
    <StepSignerSection stepId={step.id} />
  </article>;
}
