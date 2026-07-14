import { useEffect, useState } from 'react';
import type { ArtifactData } from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import { addCallStep, confirmExternalResolution, moveStep, toggleWorkflowStep, workflowDependentsForExclusion } from '../../../store/features/deployments/deployDraftSlice';
import DeployStepCard from '../components/DeployStepCard';
import CallStepCard from '../components/CallStepCard';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { workflowDocumentFromDraft } from '../../../store/features/deployments/workflowDraft';
import { collectUnboundWorkflowSlots } from '../projection';
import UnboundSlotPicker from '../components/UnboundSlotPicker';

export default function StepsStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactData>>({});
  const [pendingToggle, setPendingToggle] = useState<string>();
  const workflowDocument = draft.workflowDocument ? workflowDocumentFromDraft(draft) : undefined;
  const unbound = workflowDocument && draft.workflowRef ? collectUnboundWorkflowSlots({ document: workflowDocument, repoPathOrUrl: draft.workflowRef.repoPathOrUrl, chains: draft.chains, includedStepIds: draft.workflowIncludedStepIds ?? {}, resolutions: draft.externalResolutions }) : [];
  const unboundGroups = Object.values(Object.groupBy(unbound, (slot) => `${slot.stepId}\0${slot.path}\0${slot.sourceStepId}`));
  useEffect(() => {
    let cancelled = false;
    for (const contract of draft.contracts) {
      if (artifacts[contract.id]) continue;
      void apiClient.request('getArtifactData', { body: { pathOrUrl: contract.repoPathOrUrl, pluginId: contract.frameworkId, artifactPath: contract.artifactPath, ...(contract.pin ? { pin: contract.pin } : {}) } }).then((response) => {
        if ('data' in response && !cancelled) setArtifacts((current) => ({ ...current, [contract.id]: response.data }));
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [draft.contracts, artifacts]);
  return <section className="grid gap-4"><div><h2 className="text-lg font-semibold">Steps</h2><p className="text-sm text-muted">Arrange deployments and calls in the order they run on every chain.</p></div>
    {draft.steps.map((step, index) => <div key={step.id} className="grid gap-3">{!draft.workflowRef && <button type="button" className="btn btn-sm btn-secondary justify-self-start" onClick={() => dispatch(addCallStep(index - 1))}>+ Add call</button>}{step.kind === 'call' && draft.workflowRef && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.workflowIncludedStepIds?.[step.id] !== false} onChange={() => { const dependents = workflowDependentsForExclusion(draft, step.id); if (draft.workflowIncludedStepIds?.[step.id] !== false && dependents.length) setPendingToggle(step.id); else dispatch(toggleWorkflowStep(step.id)); }} /><span>Include call step <span className="mono-data">{step.id}</span></span></label>}{step.kind === 'deploy' ? <DeployStepCard step={step} data={artifacts[step.contractId]} onMove={(delta) => dispatch(moveStep({ fromIndex: index, toIndex: index + delta }))} /> : <CallStepCard step={step} artifactData={artifacts} onMove={(delta) => dispatch(moveStep({ fromIndex: index, toIndex: index + delta }))} />}</div>)}
    {!draft.workflowRef && <button type="button" className="btn btn-secondary justify-self-start" onClick={() => dispatch(addCallStep(draft.steps.length - 1))}>+ Add call</button>}
    {draft.workflowRef && unboundGroups.length > 0 && <div className="grid gap-3"><h3 className="font-semibold">Unresolved per-chain pointers</h3>{unboundGroups.map((slots) => {
      if (!slots?.length || !workflowDocument) return null;
      const producer = workflowDocument.steps.find((step) => step.id === slots[0].sourceStepId);
      const source = producer?.kind === 'deploy' ? workflowDocument.sources.find((item) => item.id === producer.contractId) : undefined;
      return source ? <UnboundSlotPicker key={`${slots[0].stepId}-${slots[0].path}`} repoPathOrUrl={draft.workflowRef!.repoPathOrUrl} workflowName={draft.workflowRef!.name} slots={slots} source={source} onConfirm={(resolution) => dispatch(confirmExternalResolution(resolution))} /> : null;
    })}</div>}
    <ConfirmDialog open={Boolean(pendingToggle)} onOpenChange={(open) => { if (!open) setPendingToggle(undefined); }} title="Exclude a depended-on step?" description={pendingToggle ? `These steps depend on it: ${workflowDependentsForExclusion(draft, pendingToggle).join(', ')}.` : ''} confirmText="Exclude step" variant="warning" onConfirm={() => { if (pendingToggle) dispatch(toggleWorkflowStep(pendingToggle)); }} />
  </section>;
}
