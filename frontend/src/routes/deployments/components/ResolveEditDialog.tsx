import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { GasOverrides, RpcEndpoint } from '@ignite/api';
import Select from '../../../components/Select';

interface ResolveEdits {
  gas?: GasOverrides;
  rpcEndpointId?: string;
  argsByStep?: Record<string, Record<string, unknown>>;
}

interface ResolveEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoints: RpcEndpoint[];
  initialRpcEndpointId?: string;
  onSubmit: (edits: ResolveEdits) => void;
}

export default function ResolveEditDialog({
  open,
  onOpenChange,
  endpoints,
  initialRpcEndpointId,
  onSubmit,
}: ResolveEditDialogProps) {
  const [rpcEndpointId, setRpcEndpointId] = useState(
    initialRpcEndpointId ?? ''
  );
  const [gasLimit, setGasLimit] = useState('');
  const [maxFeePerGas, setMaxFeePerGas] = useState('');
  const [maxPriorityFeePerGas, setMaxPriorityFeePerGas] = useState('');
  const [argsJson, setArgsJson] = useState('');

  useEffect(
    () => setRpcEndpointId(initialRpcEndpointId ?? ''),
    [initialRpcEndpointId]
  );

  const submit = () => {
    const gas = Object.fromEntries(
      Object.entries({ gasLimit, maxFeePerGas, maxPriorityFeePerGas }).filter(
        ([, value]) => /^\d+$/.test(value)
      )
    ) as GasOverrides;
    let argsByStep: Record<string, Record<string, unknown>> | undefined;
    if (argsJson.trim()) {
      try {
        argsByStep = JSON.parse(argsJson) as Record<
          string,
          Record<string, unknown>
        >;
      } catch {
        return;
      }
    }
    onSubmit({
      ...(Object.keys(gas).length ? { gas } : {}),
      ...(rpcEndpointId ? { rpcEndpointId } : {}),
      ...(argsByStep ? { argsByStep } : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 560, width: '92vw', padding: 24 }}
        >
          <Dialog.Title className="text-lg font-semibold">
            Edit and retry
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted mt-1 mb-4">
            Changes are recorded on the attempt. Argument edits apply only to
            the current and later steps.
          </Dialog.Description>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="eyebrow">RPC endpoint</span>
              <Select
                portal={false}
                requireSelection
                options={endpoints.map((endpoint) => ({
                  value: endpoint.id,
                  label: endpoint.label
                    ? `${endpoint.label} · ${endpoint.url}`
                    : endpoint.url,
                }))}
                value={rpcEndpointId || undefined}
                placeholder="Keep current endpoint"
                onValueChange={setRpcEndpointId}
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="grid gap-1">
                <span className="eyebrow">Gas limit</span>
                <input
                  className="input-glass"
                  value={gasLimit}
                  onChange={(event) => setGasLimit(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="eyebrow">Max fee (wei)</span>
                <input
                  className="input-glass"
                  value={maxFeePerGas}
                  onChange={(event) => setMaxFeePerGas(event.target.value)}
                />
              </label>
              <label className="grid gap-1">
                <span className="eyebrow">Priority fee (wei)</span>
                <input
                  className="input-glass"
                  value={maxPriorityFeePerGas}
                  onChange={(event) =>
                    setMaxPriorityFeePerGas(event.target.value)
                  }
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="eyebrow">Arguments by step (JSON)</span>
              <textarea
                className="input-glass mono-data"
                rows={5}
                value={argsJson}
                onChange={(event) => setArgsJson(event.target.value)}
                placeholder={'{"step-id":{"owner":"0x…"}}'}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button type="button" className="btn btn-primary" onClick={submit}>
              Save and retry
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
