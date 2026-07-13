import { useMemo, useState } from 'react';
import { parseAbiItem } from 'viem';
import type { ArtifactData } from '@ignite/api';
import type { DraftCallStep } from '../../../store/features/deployments/types';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import { setArg, setCallStepField, setGasOverride, setValue } from '../../../store/features/deployments/deployDraftSlice';
import AbiArgField, { type AbiInput } from './AbiArgField';
import AdvancedStepSection from './AdvancedStepSection';
import StepSignerSection from './StepSignerSection';
import { earlierDeploySteps } from '../pointerEligibility';

export default function CallStepCard({ step, artifactData, onMove }: { step: DraftCallStep; artifactData: Record<string, ArtifactData>; onMove: (delta: number) => void }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const [signatureError, setSignatureError] = useState<string>();
  const targets = earlierDeploySteps(draft, step.id);
  const targetValue = step.target?.kind === 'step' ? `step:${step.target.stepId}` : step.target?.kind === 'address' ? 'address' : '';
  const targetStepId = step.target?.kind === 'step' ? step.target.stepId : undefined;
  const targetDeploy = targetStepId ? draft.steps.find((item) => item.id === targetStepId && item.kind === 'deploy') : undefined;
  const functions = ((targetDeploy?.kind === 'deploy' ? artifactData[targetDeploy.contractId]?.abi : undefined) as Array<{ type?: string; name?: string; inputs?: AbiInput[]; stateMutability?: string }> | undefined ?? [])
    .filter((item) => item.type === 'function' && item.stateMutability !== 'pure')
    .map((item) => ({ signature: `${item.name ?? ''}(${(item.inputs ?? []).map((input) => input.type).join(',')})`, payable: item.stateMutability === 'payable' }));
  const parsed = useMemo(() => {
    if (!step.signature) return undefined;
    try { return parseAbiItem(`function ${step.signature}`) as { inputs?: AbiInput[]; stateMutability?: string }; } catch { return undefined; }
  }, [step.signature]);
  const setSignature = (signature: string) => {
    try { if (signature) parseAbiItem(`function ${signature}`); setSignatureError(undefined); } catch { setSignatureError('Enter a valid Solidity function signature.'); }
    dispatch(setCallStepField({ id: step.id, patch: { signature: signature || undefined } }));
  };
  return <article className="card-milky p-4 grid gap-4"><header className="flex gap-2"><div className="flex-1"><h3 className="font-semibold">Contract call</h3><p className="text-xs text-muted">Runs in this position in every chain lane.</p></div><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step up" onClick={() => onMove(-1)}>↑</button><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step down" onClick={() => onMove(1)}>↓</button></header>
    <label className="grid gap-1"><span className="eyebrow">Target</span><Select value={targetValue} requireSelection placeholder="Choose target" options={[...targets.map((item) => ({ value: `step:${item.stepId}`, label: item.label })), { value: 'address', label: 'Other address…' }]} onValueChange={(value) => dispatch(setCallStepField({ id: step.id, patch: { target: value === 'address' ? { kind: 'address', address: '0x' as `0x${string}` } : { kind: 'step', stepId: value.slice(5) } } }))} /></label>
    {step.target?.kind === 'address' && <label className="grid gap-1"><span className="eyebrow">Address</span><input className="input-glass" value={step.target.address === '0x' ? '' : step.target.address} placeholder="0x…" onChange={(event) => dispatch(setCallStepField({ id: step.id, patch: { target: { kind: 'address', address: event.target.value as `0x${string}` } } }))} /></label>}
    {step.target?.kind === 'step' ? <label className="grid gap-1"><span className="eyebrow">Function</span><Select value={step.signature} requireSelection placeholder="Choose a function" options={functions.map((item) => ({ value: item.signature, label: item.signature }))} onValueChange={(signature) => { const fn = functions.find((item) => item.signature === signature); dispatch(setCallStepField({ id: step.id, patch: { signature, payable: fn?.payable } })); }} /></label> : <><label className="grid gap-1"><span className="eyebrow">Function signature</span><input className="input-glass" value={step.signature ?? ''} placeholder="transfer(address,uint256)" onChange={(event) => setSignature(event.target.value)} />{signatureError && <span className="text-xs text-err">{signatureError}</span>}</label><label className="flex gap-2 items-center"><input type="checkbox" checked={step.payable === true} onChange={(event) => dispatch(setCallStepField({ id: step.id, patch: { payable: event.target.checked } }))} />Payable</label></>}
    {(parsed?.inputs ?? []).map((input, index) => { const key = input.name || `arg${index}`; return <AbiArgField key={key} input={input} fieldKey={key} value={step.args?.[key]} onChange={(value) => dispatch(setArg({ stepId: step.id, key, value }))} />; })}
    <AdvancedStepSection>{step.payable && <label className="grid gap-1"><span className="eyebrow">Value (native units)</span><input className="input-glass" value={step.value ?? ''} onChange={(event) => dispatch(setValue({ stepId: step.id, value: event.target.value || undefined }))} /></label>}<div className="grid grid-cols-3 gap-2">{(['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map((key) => <label key={key} className="grid gap-1"><span className="eyebrow">{key}</span><input className="input-glass" value={step.gasOverrides?.[key] ?? ''} onChange={(event) => dispatch(setGasOverride({ stepId: step.id, key, value: event.target.value || undefined }))} /></label>)}</div></AdvancedStepSection>
    <StepSignerSection stepId={step.id} />
  </article>;
}
