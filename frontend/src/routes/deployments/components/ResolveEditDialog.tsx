import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type {
  ArgValues,
  CallTarget,
  GasOverrides,
  LibraryBinding,
  RpcEndpoint,
} from '@ignite/api';
import Select from '../../../components/Select';
import { pointerPauseEditTarget } from './pointerPauseEditTarget';

export interface ResolveEdits {
  gas?: GasOverrides;
  rpcEndpointId?: string;
  argsByStep?: Record<string, Record<string, unknown>>;
  targetByStep?: Record<string, CallTarget>;
  librariesByStep?: Record<string, Record<string, LibraryBinding>>;
}

interface ResolveEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoints: RpcEndpoint[];
  initialRpcEndpointId?: string;
  step?: {
    id: string;
    kind: 'deploy' | 'call';
    args?: ArgValues;
    target?: CallTarget;
    libraries?: Record<string, LibraryBinding>;
  };
  pointerDetails?: unknown;
  onSubmit: (edits: ResolveEdits) => void;
}

function addressOf(binding: LibraryBinding | undefined): string {
  return binding?.kind === 'address' ? binding.address : '';
}

export default function ResolveEditDialog({
  open,
  onOpenChange,
  endpoints,
  initialRpcEndpointId,
  step,
  pointerDetails,
  onSubmit,
}: ResolveEditDialogProps) {
  const target = pointerPauseEditTarget(pointerDetails, step?.id);
  const directArgField = target?.section === 'args' ? target.field : undefined;
  const [rpcEndpointId, setRpcEndpointId] = useState(initialRpcEndpointId ?? '');
  const [gasLimit, setGasLimit] = useState('');
  const [maxFeePerGas, setMaxFeePerGas] = useState('');
  const [maxPriorityFeePerGas, setMaxPriorityFeePerGas] = useState('');
  const [argsJson, setArgsJson] = useState('');
  const [targetAddress, setTargetAddress] = useState('');
  const [libraryAddresses, setLibraryAddresses] = useState<Record<string, string>>({});
  const argsInput = useRef<HTMLTextAreaElement>(null);
  const targetInput = useRef<HTMLInputElement>(null);
  const libraryInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => setRpcEndpointId(initialRpcEndpointId ?? ''), [initialRpcEndpointId]);
  useEffect(() => {
    if (!open || !step) return;
    setTargetAddress(step.target?.kind === 'address' ? step.target.address : '');
    setLibraryAddresses(
      Object.fromEntries(
        Object.entries(step.libraries ?? {}).map(([key, binding]) => [
          key,
          addressOf(binding),
        ])
      )
    );
    // Only a direct top-level argument gets a prefilled entry. Nested paths
    // intentionally leave the editor blank so `args.owner.name` can never be
    // submitted as a literal `"args.owner.name"` argument key.
    setArgsJson(
      target?.section === 'args' && directArgField
        ? JSON.stringify({ [step.id]: { [directArgField]: step.args?.[directArgField] ?? '' } }, null, 2)
        : ''
    );
  }, [directArgField, open, step, target?.section]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (target?.section === 'args') argsInput.current?.focus();
      else if (target?.section === 'target') targetInput.current?.focus();
      else if (target?.section === 'libraries') libraryInputs.current[target.key]?.focus();
    });
    return () => window.clearTimeout(timer);
  }, [open, target]);

  const submit = () => {
    const gas = Object.fromEntries(
      Object.entries({ gasLimit, maxFeePerGas, maxPriorityFeePerGas }).filter(
        ([, value]) => /^\d+$/.test(value)
      )
    ) as GasOverrides;
    let argsByStep: Record<string, Record<string, unknown>> | undefined;
    if (argsJson.trim()) {
      try {
        argsByStep = JSON.parse(argsJson) as Record<string, Record<string, unknown>>;
      } catch {
        return;
      }
    }
    const libraries = Object.fromEntries(
      Object.entries(libraryAddresses).flatMap(([key, address]) =>
        address.trim()
          ? [[key, { kind: 'address' as const, address: address.trim() as `0x${string}` }]]
          : []
      )
    ) as Record<string, LibraryBinding>;
    onSubmit({
      ...(Object.keys(gas).length ? { gas } : {}),
      ...(rpcEndpointId ? { rpcEndpointId } : {}),
      ...(argsByStep ? { argsByStep } : {}),
      ...(step?.kind === 'call' && /^0x[0-9a-fA-F]{40}$/.test(targetAddress.trim())
        ? { targetByStep: { [step.id]: { kind: 'address' as const, address: targetAddress.trim() as `0x${string}` } } }
        : {}),
      ...(step?.kind === 'deploy' && Object.keys(libraries).length
        ? { librariesByStep: { [step.id]: libraries } }
        : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content glass-overlay" style={{ maxWidth: 560, width: '92vw', padding: 24 }}>
          <Dialog.Title className="text-lg font-semibold">Edit and retry</Dialog.Title>
          <Dialog.Description className="text-sm text-muted mt-1 mb-4">Changes are recorded on the attempt. Argument edits apply only to the current and later steps.</Dialog.Description>
          <div className="grid gap-3">
            <label className="grid gap-1"><span className="eyebrow">RPC endpoint</span><Select requireSelection options={endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.label ? `${endpoint.label} · ${endpoint.url}` : endpoint.url }))} value={rpcEndpointId || undefined} placeholder="Keep current endpoint" onValueChange={setRpcEndpointId} /></label>
            {step?.kind === 'call' && <label className="grid gap-1"><span className="eyebrow">Call target</span><input ref={targetInput} className="input-glass mono-data" value={targetAddress} placeholder="0x… (address override for this chain)" onChange={(event) => setTargetAddress(event.target.value)} /></label>}
            {step?.kind === 'deploy' && step.libraries && Object.keys(step.libraries).length > 0 && <section className="grid gap-2"><span className="eyebrow">Libraries</span>{Object.keys(step.libraries).map((key) => <label key={key} className="grid gap-1"><span className="text-xs mono-data">{key}</span><input ref={(input) => { libraryInputs.current[key] = input; }} className="input-glass mono-data" value={libraryAddresses[key] ?? ''} placeholder="0x… library address" onChange={(event) => setLibraryAddresses((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</section>}
            <label className="grid gap-1"><span className="eyebrow">Arguments by step (JSON)</span><textarea ref={argsInput} className="input-glass mono-data" rows={5} value={argsJson} onChange={(event) => setArgsJson(event.target.value)} placeholder={'{"step-id":{"owner":"0x…"}}'} /></label>
            <div className="grid grid-cols-3 gap-2">
              <label className="grid gap-1"><span className="eyebrow">Gas limit</span><input className="input-glass" value={gasLimit} onChange={(event) => setGasLimit(event.target.value)} /></label>
              <label className="grid gap-1"><span className="eyebrow">Max fee (wei)</span><input className="input-glass" value={maxFeePerGas} onChange={(event) => setMaxFeePerGas(event.target.value)} /></label>
              <label className="grid gap-1"><span className="eyebrow">Priority fee (wei)</span><input className="input-glass" value={maxPriorityFeePerGas} onChange={(event) => setMaxPriorityFeePerGas(event.target.value)} /></label>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5"><Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close><button type="button" className="btn btn-primary" onClick={submit}>Save and retry</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
