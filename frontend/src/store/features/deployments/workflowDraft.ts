import type {
  WorkflowDocument,
  WorkflowRunRequest,
  WorkflowStep,
} from '@ignite/api';
import type { DeployDraftState } from './types';
import { cloneJson } from '../../../utils/cloneJson';

export function workflowDocumentFromDraft(
  draft: DeployDraftState
): WorkflowDocument {
  if (!draft.workflowDocument)
    throw new Error('The draft is not bound to a workflow');
  const original = draft.workflowDocument;
  const steps: WorkflowStep[] = draft.steps.map((step) => {
    const { signerOverride: _signer, ...signerFree } = step;
    if (step.kind === 'call')
      return cloneJson(signerFree) as unknown as WorkflowStep;
    const extras = draft.deployExtras[step.id];
    const originalStep = original.steps.find((item) => item.id === step.id);
    let strategy: unknown;
    if (extras?.strategy.kind === 'create') {
      if (originalStep?.kind === 'deploy' && originalStep.strategy)
        strategy = { kind: 'create' };
    } else if (extras?.strategy.kind === 'create2') {
      strategy = {
        ...cloneJson(extras.strategy),
        ...(extras.acknowledged
          ? { acknowledgeDeployed: cloneJson(extras.acknowledged) }
          : {}),
      };
    } else if (extras?.strategy.kind === 'plugin') {
      strategy = {
        ...cloneJson(extras.strategy),
        ...(extras.prepared
          ? {
              prepared: Object.fromEntries(
                Object.entries(extras.prepared).map(([chainId, prepared]) => [
                  chainId,
                  {
                    initcodeHash: prepared.initcodeHash,
                    predictedAddress: prepared.predictedAddress,
                  },
                ])
              ),
            }
          : {}),
        ...(extras.acknowledged
          ? { acknowledgeDeployed: cloneJson(extras.acknowledged) }
          : {}),
      };
    }
    return {
      ...cloneJson(signerFree),
      ...(strategy ? { strategy } : {}),
      ...(extras?.libraries ? { libraries: cloneJson(extras.libraries) } : {}),
      ...(extras?.librariesPerChain
        ? { librariesPerChain: cloneJson(extras.librariesPerChain) }
        : {}),
    } as unknown as WorkflowStep;
  });
  return {
    schemaVersion: 1,
    ...(original.description !== undefined
      ? { description: original.description }
      : {}),
    sources: cloneJson(draft.workflowSources ?? original.sources),
    steps,
    requiredPlugins: cloneJson(
      draft.workflowRequiredPlugins ?? original.requiredPlugins
    ),
    outputs: cloneJson(draft.workflowOutputs ?? original.outputs),
  };
}

export function workflowDraftIsDirty(draft: DeployDraftState): boolean {
  if (!draft.workflowDocument) return false;
  try {
    return (
      JSON.stringify(workflowDocumentFromDraft(draft)) !==
      JSON.stringify(draft.workflowDocument)
    );
  } catch {
    return true;
  }
}

export function workflowRunRequestFromDraft(
  draft: DeployDraftState,
  installedHookIds: string[]
): WorkflowRunRequest | undefined {
  if (!draft.workflowRef) return undefined;
  const installed = new Set(installedHookIds);
  const hooks =
    draft.workflowRunHooks ??
    (draft.workflowOutputs?.hooks ?? []).filter((id) => installed.has(id));
  return {
    repoPathOrUrl: draft.workflowRef.repoPathOrUrl,
    name: draft.workflowRef.name,
    hooks,
    resolutions: draft.externalResolutions ?? [],
    ...(draft.acknowledgeArtifactDrift
      ? { acknowledgeArtifactDrift: draft.acknowledgeArtifactDrift }
      : {}),
  };
}
