import { useEffect, useState } from 'react';
import type { ArtifactData } from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import { addCallStep, moveStep } from '../../../store/features/deployments/deployDraftSlice';
import DeployStepCard from '../components/DeployStepCard';
import CallStepCard from '../components/CallStepCard';

export default function StepsStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactData>>({});
  useEffect(() => {
    let cancelled = false;
    for (const contract of draft.contracts) {
      if (artifacts[contract.id]) continue;
      void apiClient.request('getArtifactData', { body: { pathOrUrl: contract.repoPathOrUrl, pluginId: contract.frameworkId, artifactPath: contract.artifactPath } }).then((response) => {
        if ('data' in response && !cancelled) setArtifacts((current) => ({ ...current, [contract.id]: response.data }));
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [draft.contracts, artifacts]);
  return <section className="grid gap-4"><div><h2 className="text-lg font-semibold">Steps</h2><p className="text-sm text-muted">Arrange deployments and calls in the order they run on every chain.</p></div>
    {draft.steps.map((step, index) => <div key={step.id} className="grid gap-3"><button type="button" className="btn btn-sm btn-secondary justify-self-start" onClick={() => dispatch(addCallStep(index - 1))}>+ Add call</button>{step.kind === 'deploy' ? <DeployStepCard step={step} data={artifacts[step.contractId]} onMove={(delta) => dispatch(moveStep({ fromIndex: index, toIndex: index + delta }))} /> : <CallStepCard step={step} artifactData={artifacts} onMove={(delta) => dispatch(moveStep({ fromIndex: index, toIndex: index + delta }))} />}</div>)}
    <button type="button" className="btn btn-secondary justify-self-start" onClick={() => dispatch(addCallStep(draft.steps.length - 1))}>+ Add call</button>
  </section>;
}
