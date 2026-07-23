import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Save, Undo2 } from 'lucide-react';
import { useBlocker, useSearchParams } from 'react-router-dom';
import type { RepoWorkflowSource, WorkflowDocument } from '@ignite/api';
import {
  cascadeRemoveSource,
  changeSourceVersion,
  sanitizeDisplayText,
} from '@ignite/api';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import {
  pluginsApi,
  selectPluginRows,
} from '../../../store/features/plugins/pluginsSlice';
import { workflowsApi } from '../../../store/features/workflows/workflowsApi';
import {
  selectWorkflowInstall,
  selectWorkflowStatus,
} from '../../../store/features/workflows/workflowsSlice';
import SourceRow from './components/SourceRow';
import RemoveCascadeDialog from './components/RemoveCascadeDialog';

type PendingRemove = ReturnType<typeof cascadeRemoveSource> | null;

function pendingEditSummary(
  base: WorkflowDocument,
  draft: WorkflowDocument
): string[] {
  const edits: string[] = [];
  for (const source of draft.sources) {
    const prior = base.sources.find((item) => item.id === source.id);
    if (!prior) edits.push(`Added source ${source.id}`);
    else if (
      source.origin !== 'contract-type' &&
      prior.origin !== 'contract-type' &&
      source.repo.commit !== prior.repo.commit
    )
      edits.push(`Changed ${source.id} version`);
    else if (
      source.origin !== 'contract-type' &&
      prior.origin !== 'contract-type' &&
      source.artifactPath !== prior.artifactPath
    )
      edits.push(`Changed ${source.id} artifact`);
  }
  for (const source of base.sources)
    if (!draft.sources.some((item) => item.id === source.id))
      edits.push(`Removed source ${source.id}`);
  for (const step of draft.steps) {
    const prior = base.steps.find((item) => item.id === step.id);
    if (
      step.kind === 'deploy' &&
      prior?.kind === 'deploy' &&
      JSON.stringify(step.strategy) !== JSON.stringify(prior.strategy)
    )
      edits.push(`Changed deploy config for ${step.id}`);
  }
  return edits.length ? edits : ['Edited workflow document'];
}

export default function WorkflowEditorPage() {
  const dispatch = useAppDispatch();
  const [params] = useSearchParams();
  const repoPathOrUrl = params.get('workflowRepo') ?? '';
  const name = params.get('workflow') ?? '';
  const editorKey = `${repoPathOrUrl}\0${name}`;
  const status = useAppSelector((state) =>
    selectWorkflowStatus(state, repoPathOrUrl)
  )?.workflows.find((item) => item.name === name);
  const install = useAppSelector((state) =>
    selectWorkflowInstall(state, repoPathOrUrl, name)
  );
  const plugins = useAppSelector(selectPluginRows);
  const repository = useAppSelector(
    (state) => state.repositories.repositoriesData[repoPathOrUrl]
  );
  const stagedSources = useAppSelector(
    (state) => state.deployDraft.workflowSources
  );
  const stagedRef = useAppSelector((state) => state.deployDraft.workflowRef);
  const [base, setBase] = useState<WorkflowDocument>();
  const [draft, setDraft] = useState<WorkflowDocument>();
  const [baseHash, setBaseHash] = useState('');
  const [pendingRemove, setPendingRemove] = useState<PendingRemove>(null);
  const [conflict, setConflict] = useState<
    'WORKFLOW_DOC_CONFLICT' | 'WORKFLOW_DELETED' | null
  >(null);
  const [staleReport, setStaleReport] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadedEditorKey, setLoadedEditorKey] = useState('');
  const [strategyValidity, setStrategyValidity] = useState<
    Record<string, boolean>
  >({});
  const appliedHash = useRef<string>();
  const requestGeneration = useRef(0);
  const currentKey = useRef(editorKey);
  const baseRef = useRef<WorkflowDocument>();
  const draftRef = useRef<WorkflowDocument>();
  const baseHashRef = useRef('');
  currentKey.current = editorKey;
  useEffect(() => {
    baseRef.current = base;
  }, [base]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    baseHashRef.current = baseHash;
  }, [baseHash]);

  const loadWorkflow = useCallback(
    (force = false) => {
      if (!repoPathOrUrl || !name) return;
      const key = `${repoPathOrUrl}\0${name}`;
      const generation = ++requestGeneration.current;
      setLoading(true);
      dispatch(
        workflowsApi.get(repoPathOrUrl, name, {
          onSuccess: (fresh) => {
            if (
              generation !== requestGeneration.current ||
              currentKey.current !== key
            )
              return;
            setLoading(false);
            const dirtyNow = Boolean(
              baseRef.current &&
              draftRef.current &&
              JSON.stringify(baseRef.current) !==
                JSON.stringify(draftRef.current)
            );
            if (!force && dirtyNow) {
              if (fresh.docHash !== baseHashRef.current)
                setConflict('WORKFLOW_DOC_CONFLICT');
              return;
            }
            setBase(fresh.document);
            setDraft(fresh.document);
            setBaseHash(fresh.docHash);
            setLoadedEditorKey(key);
            setConflict(null);
            setStaleReport(false);
            appliedHash.current = undefined;
          },
          onError: () => {
            if (
              generation === requestGeneration.current &&
              currentKey.current === key
            )
              setLoading(false);
          },
        })
      );
    },
    [dispatch, name, repoPathOrUrl]
  );

  useEffect(() => {
    setBase(undefined);
    setDraft(undefined);
    setBaseHash('');
    setLoadedEditorKey('');
    setPendingRemove(null);
    setConflict(null);
    setStaleReport(false);
    setStrategyValidity({});
    appliedHash.current = undefined;
    if (repoPathOrUrl && name) loadWorkflow();
  }, [editorKey, loadWorkflow, name, repoPathOrUrl]);

  const profileId = useAppSelector((state) => state.profiles.currentId);
  useEffect(() => {
    if (repoPathOrUrl && profileId)
      workflowsApi
        .getWorkflowsStatus(repoPathOrUrl, profileId)
        .forEach((action) => dispatch(action));
  }, [dispatch, profileId, repoPathOrUrl]);
  useEffect(() => {
    pluginsApi.refresh().forEach((action) => dispatch(action));
  }, [dispatch]);
  useEffect(() => {
    if (!draft || !baseHash || appliedHash.current === baseHash) return;
    const acceptHash = params.get('acceptDocHash');
    if (!acceptHash) return;
    appliedHash.current = baseHash;
    if (acceptHash !== baseHash) {
      setStaleReport(true);
      return;
    }
    const sourceId = params.get('acceptSourceId');
    const commit = params.get('acceptCommit');
    const source =
      sourceId && commit
        ? draft.sources.find((item) => item.id === sourceId)
        : undefined;
    if (source && source.origin !== 'contract-type' && commit) {
      setDraft(
        changeSourceVersion(draft, source.id, {
          url: source.repo.url,
          commit,
          ...(params.get('acceptRef')
            ? {
                ref: params.get('acceptRef')!,
                refKind: params.get('acceptRefKind') as 'tag' | 'branch',
              }
            : {}),
        })
      );
      return;
    }
    if (
      stagedRef?.repoPathOrUrl === repoPathOrUrl &&
      stagedRef.name === name &&
      stagedRef.docHash === baseHash &&
      stagedSources
    ) {
      const changed = stagedSources.find((item) => {
        const current = draft.sources.find(
          (candidate) => candidate.id === item.id
        );
        return (
          item.origin !== 'contract-type' &&
          current !== undefined &&
          current.origin !== 'contract-type' &&
          item.repo.commit !== current.repo.commit
        );
      });
      if (changed && changed.origin !== 'contract-type')
        setDraft(changeSourceVersion(draft, changed.id, changed.repo));
    }
  }, [baseHash, draft, name, params, repoPathOrUrl, stagedRef, stagedSources]);
  useEffect(() => {
    const highlight = params.get('highlight');
    if (!highlight || !draft) return;
    const element = document.getElementById(`workflow-source-${highlight}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [draft, params]);

  const dirty = Boolean(
    base && draft && JSON.stringify(base) !== JSON.stringify(draft)
  );
  const blocker = useBlocker(dirty);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  const edits = useMemo(
    () => (base && draft ? pendingEditSummary(base, draft) : []),
    [base, draft]
  );
  const installing =
    status?.attempt?.status === 'running' ||
    install?.status === 'queued' ||
    install?.status === 'running';
  const strategiesValid = Object.values(strategyValidity).every(Boolean);
  const save = () => {
    if (!draft || !baseHash || installing || !strategiesValid) return;
    dispatch(
      workflowsApi.saveWorkflow({
        repoPathOrUrl,
        name,
        document: draft,
        baseDocHash: baseHash,
        onSaved: (docHash) => {
          setBase(draft);
          setBaseHash(docHash);
          dispatch(
            workflowsApi.installWorkflow(
              { repoPathOrUrl, name, expectedDocHash: docHash },
              profileId ?? undefined
            )
          );
        },
        onConflict: setConflict,
      })
    );
  };
  const reload = () => {
    setConflict(null);
    loadWorkflow(true);
  };
  if (!repoPathOrUrl || !name)
    return (
      <div className="card-milky p-6 text-err">
        Choose a workflow from the Workflows page.
      </div>
    );
  if (loading || loadedEditorKey !== editorKey || !draft || !base)
    return (
      <div className="card-milky p-6 flex gap-3 items-center text-muted">
        <Loader2 size={18} className="animate-spin" /> Loading workflow…
      </div>
    );
  return (
    <div className="text-[var(--text)]">
      <header className="mb-6 flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="page-title">Edit {sanitizeDisplayText(name)}</h1>
          <p className="text-muted mt-1">
            Changes are written to the repository working tree.
          </p>
        </div>
        {repository?.initialized && repository.info?.dirty && (
          <span className="pill pill-warning rounded-full px-3 py-1 mono-data shrink-0 self-start">
            dirty
          </span>
        )}
      </header>
      {staleReport && (
        <div className="card-milky p-4 mb-4 text-sm pill-warning">
          This update report is stale — re-check for new versions before
          accepting it.
        </div>
      )}
      <div className="grid gap-4">
        {draft.sources.map((source) =>
          source.origin === 'contract-type' ? (
            <div key={source.id} className="card-milky p-5">
              <div className="font-semibold">
                {sanitizeDisplayText(source.contractName)}
              </div>
              <div className="text-sm text-muted">
                Contract type: {sanitizeDisplayText(source.pluginId)}
              </div>
            </div>
          ) : (
            <SourceRow
              key={source.id}
              source={source as RepoWorkflowSource}
              document={draft}
              status={status}
              plugins={plugins}
              highlighted={params.get('highlight') === source.id}
              onChange={setDraft}
              onStrategyValidityChange={(valid) =>
                setStrategyValidity((current) =>
                  current[source.id] === valid
                    ? current
                    : { ...current, [source.id]: valid }
                )
              }
              onRemove={() =>
                setPendingRemove(cascadeRemoveSource(draft, source.id))
              }
            />
          )
        )}
      </div>
      <div className="sticky bottom-4 mt-6 card-milky p-4 flex items-center justify-between gap-4">
        <div className="text-sm text-muted">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
          {!strategiesValid
            ? ' · Correct deployment parameters before saving'
            : ''}
          {installing ? ' · Install is running' : ''}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!dirty}
            onClick={() => setDraft(base)}
          >
            <Undo2 size={15} /> Discard
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty || installing || !strategiesValid}
            title={
              installing
                ? 'Wait for the workflow install to finish before saving.'
                : undefined
            }
            onClick={save}
          >
            <Save size={15} /> Save
          </button>
        </div>
      </div>
      <RemoveCascadeDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        removedStepIds={pendingRemove?.removedStepIds ?? []}
        clearedRefs={pendingRemove?.clearedRefs ?? []}
        onConfirm={() => {
          if (pendingRemove) setDraft(pendingRemove.doc);
          setPendingRemove(null);
        }}
      />
      <Dialog.Root
        open={conflict !== null}
        onOpenChange={(open) => !open && setConflict(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content glass-overlay max-w-lg w-[92vw] p-5">
            <Dialog.Title className="text-lg font-semibold">
              Workflow changed on disk
            </Dialog.Title>
            <Dialog.Description className="text-sm text-muted mt-1">
              {conflict === 'WORKFLOW_DELETED'
                ? 'The workflow was deleted.'
                : 'Another edit changed the workflow.'}{' '}
              Reload it, then reapply these local edits manually.
            </Dialog.Description>
            <ul className="mt-4 list-disc pl-5 text-sm">
              {edits.map((edit) => (
                <li key={edit}>{sanitizeDisplayText(edit)}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConflict(null)}
              >
                Keep local view
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={reload}
              >
                Reload workflow
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content glass-overlay max-w-lg w-[92vw] p-5">
            <Dialog.Title className="text-lg font-semibold">
              Discard unsaved changes?
            </Dialog.Title>
            <Dialog.Description className="text-sm text-muted mt-1">
              Your workflow edits have not been saved.
            </Dialog.Description>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => blocker.reset?.()}
              >
                Stay here
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => blocker.proceed?.()}
              >
                Leave without saving
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
