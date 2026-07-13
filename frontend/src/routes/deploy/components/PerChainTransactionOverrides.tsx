import { useAppDispatch, useAppSelector } from '../../../store';
import { setGasOverridePerChain, setValuePerChain } from '../../../store/features/deployments/deployDraftSlice';

export default function PerChainTransactionOverrides({ stepId, showValue = false }: { stepId: string; showValue?: boolean }) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const step = draft.steps.find((item) => item.id === stepId);
  if (!step || draft.chains.length < 2) return null;
  return <details className="text-xs"><summary className="text-muted cursor-pointer">Per-chain transaction overrides</summary><div className="grid gap-3 mt-2">{draft.chains.map((chainId) => <div key={chainId} className="card-milky p-3 grid gap-2"><span className="font-medium">{chains.find((chain) => chain.chainId === chainId)?.name ?? chainId}</span>{showValue && <label className="grid gap-1"><span className="eyebrow">Value (native units)</span><input className="input-glass" value={step.valuePerChain?.[String(chainId)] ?? ''} placeholder="Use global" onChange={(event) => dispatch(setValuePerChain({ stepId, chainId, value: event.target.value || undefined }))} /></label>}<div className="grid grid-cols-3 gap-2">{(['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const).map((key) => <label key={key} className="grid gap-1"><span className="eyebrow">{key}</span><input className="input-glass" value={step.gasOverridesPerChain?.[String(chainId)]?.[key] ?? ''} placeholder="Use global" onChange={(event) => dispatch(setGasOverridePerChain({ stepId, chainId, key, value: event.target.value || undefined }))} /></label>)}</div></div>)}</div></details>;
}
