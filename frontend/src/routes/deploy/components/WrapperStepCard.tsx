import { useEffect, useMemo, useState } from 'react';
import { toFunctionSignature, type AbiFunction } from 'viem';
import type { ContractTypeInfo } from '@ignite/api';
import { ApiError } from '@ignite/api/client';
import Select from '../../../components/Select';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import { refreshContractTypeSource, setAcknowledgeUninitialized, setAcknowledgeUnverifiedBytecode, setArg, setChainArgOverride, setValue, setWrapperInitializer } from '../../../store/features/deployments/deployDraftSlice';
import type { DraftDeployStep } from '../../../store/features/deployments/types';
import AbiArgField, { type AbiInput } from './AbiArgField';
import AdvancedStepSection from './AdvancedStepSection';
import PerChainTransactionOverrides from './PerChainTransactionOverrides';
import StepSignerSection from './StepSignerSection';
import StrategySection from './StrategySection';
import { eligiblePointerSteps } from '../pointerEligibility';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';

type AbiFunctionLike = { type?: string; name?: string; inputs?: AbiInput[]; stateMutability?: string };
type Encode = { $encode: { contractId: string; fn: string; args?: Record<string, unknown> } };
const isEncode = (value: unknown): value is Encode => Boolean(value && typeof value === 'object' && '$encode' in value);

export default function WrapperStepCard({ step, implementationAbi, onMove }: { step: DraftDeployStep; implementationAbi?: unknown[]; onMove: (delta: number) => void }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const source = draft.contracts.find((contract) => contract.id === step.contractId);
  const implementation = draft.steps.find((candidate) => candidate.id === step.wraps?.stepId && candidate.kind === 'deploy');
  const implementationContract = implementation && draft.contracts.find((contract) => contract.id === implementation.contractId);
  const [type, setType] = useState<ContractTypeInfo>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void apiClient.request('listContractTypes', {}).then((response) => {
      if ('data' in response && !cancelled) setType(response.data.contractTypes.find((entry) => entry.pluginId === (source?.origin === 'contract-type' ? source.pluginId : undefined)));
    }).catch((reason) => { if (!cancelled) setError(reason instanceof ApiError ? (reason.body.message ?? reason.message) : String(reason)); });
    return () => { cancelled = true; };
  }, [source]);
  const initializerArg = type?.synthesis?.constructorArgs.find((arg) => arg.from === 'initializer')?.name;
  const data = initializerArg ? step.args?.[initializerArg] : undefined;
  const selected = step.initializerSelection ?? (isEncode(data) ? data.$encode.fn : '');
  const functions = useMemo(() => (implementationAbi as AbiFunctionLike[] | undefined ?? []).filter((item) => item.type === 'function' && item.stateMutability !== 'view' && item.stateMutability !== 'pure').map((item) => ({ item, signature: toFunctionSignature(item as unknown as AbiFunction), payable: item.stateMutability === 'payable' })), [implementationAbi]);
  const selectedFunction = functions.find((item) => item.signature === selected);
  // Default only when the convention is unambiguous. A user's explicit
  // selection is stored as a complete $encode value in the draft.
  useEffect(() => {
    if (!initializerArg || step.initializerSelection !== undefined || selected || data !== '0x') return;
    const initialize = functions.filter((item) => item.item.name === 'initialize');
    if (initialize.length === 1) dispatch(setWrapperInitializer({ stepId: step.id, key: initializerArg, selection: initialize[0].signature, payable: initialize[0].payable, value: { $encode: { contractId: implementationContract?.id ?? '', fn: initialize[0].signature, args: {} } } }));
  }, [data, dispatch, functions, implementationContract?.id, initializerArg, selected, step.id, step.initializerSelection]);
  const pointerSteps = eligiblePointerSteps(draft, step.id);
  const setInitializer = (signature: string) => {
    if (!initializerArg) return;
    const functionInfo = functions.find((item) => item.signature === signature);
    dispatch(setWrapperInitializer({ stepId: step.id, key: initializerArg, selection: signature, payable: functionInfo?.payable, value: signature ? { $encode: { contractId: implementationContract?.id ?? '', fn: signature, args: {} } } : '0x' }));
  };
  const setInitializerArg = (key: string, value: unknown, chainId?: number) => {
    if (!initializerArg || !selectedFunction) return;
    if (chainId === undefined) {
      const current = isEncode(step.args?.[initializerArg]) ? step.args![initializerArg] as Encode : { $encode: { contractId: implementationContract?.id ?? '', fn: selectedFunction.signature, args: {} } };
      dispatch(setArg({ stepId: step.id, key: initializerArg, value: { $encode: { ...current.$encode, args: { ...(current.$encode.args ?? {}), [key]: value } } } }));
      return;
    }
    const current = isEncode(step.argsPerChain?.[String(chainId)]?.[initializerArg]) ? step.argsPerChain![String(chainId)]![initializerArg] as Encode : { $encode: { contractId: implementationContract?.id ?? '', fn: selectedFunction.signature, args: {} } };
    dispatch(setChainArgOverride({ stepId: step.id, chainId, key: initializerArg, value: { $encode: { ...current.$encode, args: { ...(current.$encode.args ?? {}), [key]: value } } } }));
  };
  const refreshContractType = () => {
    if (!source || source.origin !== 'contract-type') return;
    setError(undefined);
    void apiClient.request('listContractTypes', {}).then((response) => {
      if (!('data' in response)) throw new Error(response.message);
      const current = response.data.contractTypes.find((entry) => entry.pluginId === source.pluginId && entry.synthesis?.artifact === source.artifactKey);
      if (!current) throw new Error('This contract type is no longer available. Reselect a contract type.');
      dispatch(refreshContractTypeSource({ sourceId: source.id, versionLabel: current.versionLabel, contentHash: current.contentHash }));
    }).catch((reason) => setError(reason instanceof ApiError ? (reason.body.message ?? reason.message) : String(reason)));
  };
  if (!source || source.origin !== 'contract-type' || !step.wraps) return null;
  return <article className="card-milky p-4 grid gap-4">
    <header className="flex gap-2 items-start"><div className="flex-1"><h3 className="font-semibold">{source.contractName}</h3><p className="mono-data text-muted">{source.pluginId} @ {source.versionLabel}</p></div><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step up" onClick={() => onMove(-1)}>↑</button><button type="button" className="btn btn-sm btn-secondary" aria-label="Move step down" onClick={() => onMove(1)}>↓</button></header>
    <section className="grid gap-1"><span className="eyebrow">Implementation</span><span className="mono-data">{implementationContract?.contractName ?? decodeUrlEncodingForDisplay(step.wraps.stepId)}</span></section>
    <div><button type="button" className="btn btn-sm btn-secondary" onClick={refreshContractType}>Refresh contract type</button></div>
    {error && <p className="text-sm text-err">{error}</p>}
    {type?.params.map((param) => { const argName = type.synthesis?.constructorArgs.find((arg) => arg.from === 'param' && arg.param === param.key)?.name ?? param.key; const input: AbiInput = { name: param.label, type: param.type === 'number' ? 'uint256' : param.type === 'boolean' ? 'bool' : param.type === 'select' ? 'string' : param.type }; const setParam = (value: unknown, chainId?: number) => chainId === undefined ? dispatch(setArg({ stepId: step.id, key: argName, value })) : dispatch(setChainArgOverride({ stepId: step.id, chainId, key: argName, value })); const field = (value: unknown, chainId?: number) => param.type === 'select' ? <label className="grid gap-1"><span className="text-sm font-medium">{param.label}</span><Select value={typeof value === 'string' ? value : undefined} options={param.options ?? []} onValueChange={(next) => setParam(next, chainId)} /></label> : <AbiArgField input={input} fieldKey={argName} value={value} eligibleSteps={param.type === 'address' ? pointerSteps : undefined} autoDefault={param.type === 'boolean' && chainId === undefined} onChange={(value) => setParam(value, chainId)} />; return <div key={param.key} className="grid gap-2">{field(step.args?.[argName])}{draft.chains.length > 1 && <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain override</summary>{draft.chains.map((chainId) => <div key={chainId} className="mt-2">{field(step.argsPerChain?.[String(chainId)]?.[argName], chainId)}</div>)}</details>}</div>; })}
    {initializerArg && <section className="grid gap-3"><label className="grid gap-1"><span className="eyebrow">Initializer</span><Select value={selected} options={[{ value: '', label: 'No initialization (empty calldata)' }, ...functions.map((item) => ({ value: item.signature, label: item.signature }))]} onValueChange={setInitializer} /></label>{selectedFunction?.item.inputs?.map((input, index) => { const key = input.name || `arg${index}`; const global = isEncode(step.args?.[initializerArg]) ? step.args![initializerArg] as Encode : undefined; return <div key={key} className="grid gap-2"><AbiArgField input={input} fieldKey={key} value={global?.$encode.args?.[key]} eligibleSteps={pointerSteps} onChange={(value) => setInitializerArg(key, value)} />{draft.chains.length > 1 && <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain override</summary>{draft.chains.map((chainId) => { const override = step.argsPerChain?.[String(chainId)]?.[initializerArg]; return <div key={chainId} className="mt-2 grid gap-1"><AbiArgField input={input} fieldKey={key} value={isEncode(override) ? override.$encode.args?.[key] : undefined} eligibleSteps={pointerSteps} onChange={(value) => setInitializerArg(key, value, chainId)} />{override !== undefined && <button type="button" className="btn btn-sm btn-secondary justify-self-start" onClick={() => dispatch(setChainArgOverride({ stepId: step.id, chainId, key: initializerArg, value: undefined }))}>Use global</button>}</div>; })}</details>}</div>; })}</section>}
    {initializerArg && !selected && (implementationAbi as AbiFunctionLike[] | undefined)?.some((item) => item.type === 'function' && item.name === 'initialize') && <label className="flex gap-2 text-sm text-warn"><input type="checkbox" checked={step.acknowledgeUninitialized === true} onChange={(event) => dispatch(setAcknowledgeUninitialized({ stepId: step.id, acknowledged: event.target.checked }))} />I understand that anyone may initialize this proxy after deployment; deterministic deployments can be front-run.</label>}
    <label className="flex gap-2 text-sm text-warn"><input type="checkbox" checked={step.acknowledgeUnverifiedBytecode === true} onChange={(event) => dispatch(setAcknowledgeUnverifiedBytecode({ stepId: step.id, acknowledged: event.target.checked }))} />I understand this wrapper may use plugin-supplied bytecode that is not reproduced from its claimed sources.</label>
    <StrategySection stepId={step.id} />
    <AdvancedStepSection>{selectedFunction?.payable && <label className="grid gap-1"><span className="eyebrow">Value (native units)</span><input className="input-glass" value={step.value ?? ''} onChange={(event) => dispatch(setValue({ stepId: step.id, value: event.target.value || undefined }))} /></label>}<PerChainTransactionOverrides stepId={step.id} showValue={Boolean(selectedFunction?.payable)} /></AdvancedStepSection>
    <StepSignerSection stepId={step.id} />
  </article>;
}
