import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { parseAbiItem } from 'viem';
import type { ArtifactData, CallTarget } from '@ignite/api';
import type { DraftCallStep } from '../../../store/features/deployments/types';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import {
  removeCallStep,
  setArg,
  setCallStepField,
  setChainArgOverride,
  setGasOverride,
  setValue,
} from '../../../store/features/deployments/deployDraftSlice';
import AbiArgField, { type AbiInput } from './AbiArgField';
import AdvancedStepSection from './AdvancedStepSection';
import StepSignerSection from './StepSignerSection';
import {
  callArgumentPointerSteps,
  callTargetPointerSteps,
} from '../pointerEligibility';
import PerChainTransactionOverrides from './PerChainTransactionOverrides';
import { callFunctionOptions } from './callFunctionSignatures';

function targetValue(target: CallTarget | undefined | null): string {
  return target?.kind === 'step'
    ? `step:${target.stepId}`
    : target?.kind === 'address'
      ? 'address'
      : '';
}

function TargetPicker({
  target,
  targets,
  onChange,
  allowGlobal,
}: {
  target?: CallTarget | null;
  targets: ReturnType<typeof callTargetPointerSteps>;
  onChange: (target: CallTarget | undefined) => void;
  allowGlobal?: boolean;
}) {
  const value = targetValue(target);
  return (
    <div className="grid gap-2">
      <Select
        value={value || undefined}
        requireSelection={!allowGlobal}
        placeholder={allowGlobal ? 'Use global target' : 'Choose target'}
        options={[
          ...(allowGlobal ? [{ value: 'global', label: 'Use global target' }] : []),
          ...targets.map((item) => ({ value: `step:${item.stepId}`, label: item.label })),
          { value: 'address', label: 'Other address…' },
        ]}
        onValueChange={(next) => {
          if (next === 'global') onChange(undefined);
          else if (next === 'address')
            onChange({ kind: 'address', address: '0x' as `0x${string}` });
          else onChange({ kind: 'step', stepId: next.slice(5) });
        }}
      />
      {target?.kind === 'address' && (
        <input
          className="input-glass"
          value={target.address === '0x' ? '' : target.address}
          placeholder="0x…"
          onChange={(event) =>
            onChange({ kind: 'address', address: event.target.value as `0x${string}` })
          }
        />
      )}
    </div>
  );
}

export default function CallStepCard({ step, artifactData, onMove }: { step: DraftCallStep; artifactData: Record<string, ArtifactData>; onMove: (delta: number) => void }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const [signatureError, setSignatureError] = useState<string>();
  const targets = callTargetPointerSteps(draft, step.id);
  const argPointers = callArgumentPointerSteps(draft, step.id);
  const targetStepId = step.target?.kind === 'step' ? step.target.stepId : undefined;
  const targetDeploy = targetStepId ? draft.steps.find((item) => item.id === targetStepId && item.kind === 'deploy') : undefined;
  // Calls to a wrapper are encoded against the implementation interface,
  // matching core's callTargetAbi routing (e.g. UUPS upgradeToAndCall).
  const callTargetDeploy = targetDeploy?.kind === 'deploy' && targetDeploy.wraps
    ? draft.steps.find((item) => item.id === targetDeploy.wraps!.stepId && item.kind === 'deploy')
    : targetDeploy;
  const functions = callFunctionOptions(
    (callTargetDeploy?.kind === 'deploy'
      ? artifactData[callTargetDeploy.contractId]?.abi
      : undefined) as Array<{ type?: string; name?: string; inputs?: AbiInput[]; stateMutability?: string }> | undefined
  );
  const parsed = useMemo(() => {
    if (!step.signature) return undefined;
    try { return parseAbiItem(`function ${step.signature}`) as { inputs?: AbiInput[]; stateMutability?: string }; } catch { return undefined; }
  }, [step.signature]);
  const setSignature = (signature: string) => {
    try { if (signature) parseAbiItem(`function ${signature}`); setSignatureError(undefined); } catch { setSignatureError('Enter a valid Solidity function signature.'); }
    dispatch(setCallStepField({ id: step.id, patch: { signature: signature || undefined } }));
  };
  const setTargetPerChain = (chainId: number, target: CallTarget | undefined) => {
    const next = { ...(step.targetPerChain ?? {}) };
    if (target) next[String(chainId)] = target;
    else delete next[String(chainId)];
    dispatch(setCallStepField({
      id: step.id,
      patch: { targetPerChain: Object.keys(next).length ? next : undefined },
    }));
  };
  return <article className="card-milky p-4 grid gap-4"><header className="flex gap-2"><div className="flex-1"><h3 className="font-semibold">Contract call</h3><p className="text-xs text-muted">Runs in this position in every chain lane.</p></div><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step up" onClick={() => onMove(-1)}>↑</button><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step down" onClick={() => onMove(1)}>↓</button><button type="button" className="btn btn-sm btn-secondary" aria-label="Remove step" onClick={() => dispatch(removeCallStep(step.id))}>✕</button></header>
    <section className="grid gap-2"><span className="eyebrow">Target</span><TargetPicker target={step.target} targets={targets} onChange={(target) => dispatch(setCallStepField({ id: step.id, patch: { target: target ?? null } }))} />{draft.chains.length > 1 && <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain target</summary><div className="grid gap-3 mt-2">{draft.chains.map((chainId) => <div key={chainId} className="card-milky p-3 grid gap-2"><span className="font-medium">{chains.find((chain) => chain.chainId === chainId)?.name ?? chainId}</span><TargetPicker target={step.targetPerChain?.[String(chainId)]} targets={targets} allowGlobal onChange={(target) => setTargetPerChain(chainId, target)} /></div>)}</div></details>}</section>
    {step.target?.kind === 'step' ? <label className="grid gap-1"><span className="eyebrow">Function</span>{callTargetDeploy?.kind === 'deploy' && !artifactData[callTargetDeploy.contractId] ? <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Loading functions…</p> : <Select value={step.signature} requireSelection placeholder="Choose a function" options={functions.map((item) => ({ value: item.signature, label: item.signature }))} onValueChange={(signature) => { const fn = functions.find((item) => item.signature === signature); dispatch(setCallStepField({ id: step.id, patch: { signature, payable: fn?.payable } })); }} />}</label> : <><label className="grid gap-1"><span className="eyebrow">Function signature</span><input className="input-glass" value={step.signature ?? ''} placeholder="transfer(address,uint256)" onChange={(event) => setSignature(event.target.value)} />{signatureError && <span className="text-xs text-err">{signatureError}</span>}</label><label className="flex gap-2 items-center"><input type="checkbox" checked={step.payable === true} onChange={(event) => dispatch(setCallStepField({ id: step.id, patch: { payable: event.target.checked } }))} />Payable</label></>}
    {(parsed?.inputs ?? []).length > 0 && <section className="grid gap-3"><h4 className="font-medium">Arguments</h4>{(parsed?.inputs ?? []).map((input, index) => { const key = input.name || `arg${index}`; return <div key={key} className="grid gap-2"><AbiArgField input={input} fieldKey={key} value={step.args?.[key]} eligibleSteps={argPointers} onChange={(value) => dispatch(setArg({ stepId: step.id, key, value }))} />{draft.chains.length > 1 && <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain override</summary>{draft.chains.map((chainId) => <div key={chainId} className="mt-2"><AbiArgField input={input} fieldKey={key} value={step.argsPerChain?.[String(chainId)]?.[key]} eligibleSteps={argPointers} onChange={(value) => dispatch(setChainArgOverride({ stepId: step.id, chainId, key, value }))} /></div>)}</details>}</div>; })}</section>}
    <AdvancedStepSection>{step.payable && <label className="grid gap-1"><span className="eyebrow">Value (native units)</span><input className="input-glass" value={step.value ?? ''} onChange={(event) => dispatch(setValue({ stepId: step.id, value: event.target.value || undefined }))} /></label>}<div className="grid grid-cols-3 gap-2">{(['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map((key) => <label key={key} className="grid gap-1"><span className="eyebrow">{key}</span><input className="input-glass" value={step.gasOverrides?.[key] ?? ''} onChange={(event) => dispatch(setGasOverride({ stepId: step.id, key, value: event.target.value || undefined }))} /></label>)}</div><PerChainTransactionOverrides stepId={step.id} showValue={step.payable} /></AdvancedStepSection>
    <StepSignerSection stepId={step.id} />
  </article>;
}
