import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Plus, X } from 'lucide-react';
import {
  appendSource,
  sanitizeDisplayText,
  stripGitUrlCredentials,
  type ArtifactLocation,
  type ContractSourcePin,
  type WorkflowDocument,
  type WorkflowRequiredPlugin,
  type WorkflowSource,
} from '@ignite/api';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import { workflowsApi } from '../../../store/features/workflows/workflowsApi';
import {
  pluginsApi,
  type PluginRow,
} from '../../../store/features/plugins/pluginsSlice';
import { getRepoName } from '../../../utils/repo';

type WorkflowTarget = { repoPathOrUrl: string; name: string };

interface WorkflowDocumentClient {
  getWorkflow: (
    target: WorkflowTarget
  ) => Promise<{ document: WorkflowDocument; docHash: string }>;
  putWorkflow: (input: {
    target: WorkflowTarget;
    document: WorkflowDocument;
    baseDocHash: string;
  }) => Promise<{ docHash: string }>;
}

export function canAddToWorkflow(pin?: ContractSourcePin): boolean {
  return Boolean(pin);
}

export function workflowSourceFromArtifact(
  artifact: ArtifactLocation,
  pin: ContractSourcePin,
  frameworkId: string
): WorkflowSource {
  return {
    id: 'pending',
    repo: {
      url: pin.url,
      commit: pin.commit,
      ...(pin.ref ? { ref: pin.ref } : {}),
      ...(pin.refKind ? { refKind: pin.refKind } : {}),
    },
    frameworkId,
    sourcePath: artifact.sourcePath,
    contractName: artifact.contractName,
    artifactPath: artifact.artifactPath,
  };
}

export function compilerRequiredPlugin(
  frameworkId: string,
  row: PluginRow | undefined
): {
  plugin?: WorkflowRequiredPlugin;
  error?: string;
  credentialsRemoved?: boolean;
} {
  if (!row)
    return {
      error: `Install and trust the ${frameworkId} compiler plugin before adding contracts to a workflow.`,
    };
  if (row.trust === 'untrusted')
    return {
      error: `Trust the ${frameworkId} compiler plugin before adding contracts to a workflow.`,
    };
  if (!row.types.includes('compiler'))
    return {
      error: `${frameworkId} is installed but does not provide the compiler capability required by this contract.`,
    };
  if (!row.version || !row.source)
    return {
      error: `The installed ${frameworkId} compiler plugin has no versioned install source to record in the workflow.`,
    };
  const credentialsRemoved =
    row.source.kind === 'git' &&
    stripGitUrlCredentials(row.source.url) !== row.source.url;
  const source =
    row.source.kind === 'git'
      ? { ...row.source, url: stripGitUrlCredentials(row.source.url) }
      : { ...row.source };
  return {
    plugin: {
      id: row.pluginId,
      version: row.version,
      source,
    },
    credentialsRemoved,
  };
}

export function isWorkflowDocumentConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    body?: { code?: unknown };
  };
  return (
    candidate.status === 409 &&
    (candidate.body?.code === 'WORKFLOW_DOC_CONFLICT' ||
      candidate.body?.code === 'WORKFLOW_DELETED')
  );
}

export function workflowEditorPath(
  target: WorkflowTarget,
  sourceId: string
): string {
  const params = new URLSearchParams({
    workflowRepo: target.repoPathOrUrl,
    workflow: target.name,
    highlight: sourceId,
  });
  return `/workflows/edit?${params.toString()}`;
}

export async function appendArtifactsToWorkflow(
  client: WorkflowDocumentClient,
  input: {
    target: WorkflowTarget;
    artifacts: ArtifactLocation[];
    pin: ContractSourcePin;
    frameworkId: string;
    requiredPlugin: WorkflowRequiredPlugin;
  }
): Promise<{
  document: WorkflowDocument;
  docHash: string;
  sourceIds: string[];
}> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await client.getWorkflow(input.target);
    let document = current.document;
    const sourceIds: string[] = [];
    for (const artifact of input.artifacts) {
      const appended = appendSource(
        document,
        workflowSourceFromArtifact(artifact, input.pin, input.frameworkId),
        input.requiredPlugin
      );
      document = appended.doc;
      sourceIds.push(appended.sourceId);
    }
    try {
      const saved = await client.putWorkflow({
        target: input.target,
        document,
        baseDocHash: current.docHash,
      });
      return { document, docHash: saved.docHash, sourceIds };
    } catch (error) {
      if (attempt === 0 && isWorkflowDocumentConflict(error)) continue;
      throw error;
    }
  }
  throw new Error('Workflow could not be updated.');
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { body?: { message?: unknown } };
    if (typeof candidate.body?.message === 'string')
      return candidate.body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export default function AddToWorkflowDialog({
  open,
  onOpenChange,
  artifacts,
  frameworkId,
  pin,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: ArtifactLocation[];
  frameworkId: string;
  pin: ContractSourcePin;
  onAdded: () => void;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const repositories = useAppSelector(
    (state) => state.repositories.repositories
  );
  const workflowLists = useAppSelector((state) => state.workflows.byRepo);
  const compilerPlugin = useAppSelector(
    (state) => state.plugins.rows[frameworkId]
  );
  const [savingTarget, setSavingTarget] = useState<string>();
  const [error, setError] = useState<string>();
  const repos = useMemo(
    () => [...(repositories?.local ?? []), ...(repositories?.cloned ?? [])],
    [repositories]
  );
  const plugin = compilerRequiredPlugin(frameworkId, compilerPlugin);

  useEffect(() => {
    if (!open) return;
    repos.forEach((repo) => {
      workflowsApi.list(repo.pathOrUrl).forEach((action) => dispatch(action));
    });
    pluginsApi.refresh().forEach((action) => dispatch(action));
  }, [dispatch, open, repos]);

  const addToWorkflow = async (target: WorkflowTarget) => {
    if (!plugin.plugin || !artifacts.length) return;
    const targetKey = `${target.repoPathOrUrl}\0${target.name}`;
    setSavingTarget(targetKey);
    setError(undefined);
    try {
      const result = await appendArtifactsToWorkflow(
        {
          getWorkflow: async (selectedTarget) => {
            const response = await apiClient.request<'getWorkflow'>(
              'getWorkflow',
              {
                params: { name: selectedTarget.name },
                query: { pathOrUrl: selectedTarget.repoPathOrUrl },
              } as never
            );
            if (!('data' in response))
              throw new Error('Invalid workflow document response.');
            return response.data;
          },
          putWorkflow: async ({
            target: selectedTarget,
            document,
            baseDocHash,
          }) => {
            const response = await apiClient.request<'putWorkflow'>(
              'putWorkflow',
              {
                params: { name: selectedTarget.name },
                query: { pathOrUrl: selectedTarget.repoPathOrUrl },
                body: { document, baseDocHash },
              } as never
            );
            if (!('data' in response))
              throw new Error('Invalid workflow save response.');
            return response.data;
          },
        },
        {
          target,
          artifacts,
          pin,
          frameworkId,
          requiredPlugin: plugin.plugin,
        }
      );
      onAdded();
      onOpenChange(false);
      navigate(workflowEditorPath(target, result.sourceIds[0]));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingTarget(undefined);
    }
  };

  const hasValidWorkflow = repos.some((repo) =>
    (workflowLists[repo.pathOrUrl]?.workflows ?? []).some(
      (workflow) => workflow.valid
    )
  );
  const workflowListsLoaded = repos.every(
    (repo) =>
      workflowLists[repo.pathOrUrl] && !workflowLists[repo.pathOrUrl].loading
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 680, width: '92vw', padding: 24 }}
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <Dialog.Title className="text-lg font-semibold">
                Add to workflow
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted">
                Add {artifacts.length} selected contract
                {artifacts.length === 1 ? '' : 's'} from this pinned version.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-secondary btn-icon" aria-label="Close">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {plugin.error && (
            <div className="text-sm text-err mb-3">{plugin.error}</div>
          )}
          {plugin.credentialsRemoved && (
            <div className="text-sm pill-warning mb-3">
              Credentials removed from plugin source.
            </div>
          )}
          {error && <div className="text-sm text-err mb-3">{error}</div>}

          <div className="grid gap-4 max-h-[60vh] overflow-y-auto pr-1">
            {repositories === null ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 size={16} className="animate-spin" /> Loading
                repositories...
              </div>
            ) : (
              repos.map((repo) => {
                const list = workflowLists[repo.pathOrUrl];
                return (
                  <section key={repo.pathOrUrl} className="grid gap-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">
                        {sanitizeDisplayText(getRepoName(repo.pathOrUrl))}
                      </h3>
                      <p className="mono-data text-muted truncate">
                        {sanitizeDisplayText(repo.pathOrUrl)}
                      </p>
                    </div>
                    {!list || list.loading ? (
                      <div className="flex items-center gap-2 text-sm text-muted">
                        <Loader2 size={14} className="animate-spin" /> Loading
                        workflows...
                      </div>
                    ) : list.error ? (
                      <div className="text-sm text-err">
                        {sanitizeDisplayText(list.error)}
                      </div>
                    ) : (
                      <div className="glass-list">
                        {list.workflows.map((workflow) => {
                          const targetKey = `${repo.pathOrUrl}\0${workflow.name}`;
                          const disabled =
                            !workflow.valid ||
                            !plugin.plugin ||
                            Boolean(savingTarget);
                          return (
                            <button
                              key={workflow.name}
                              type="button"
                              className="list-row clickable text-left disabled:opacity-50"
                              disabled={disabled}
                              title={
                                !workflow.valid
                                  ? sanitizeDisplayText(
                                      workflow.error ??
                                        'This workflow is invalid.'
                                    )
                                  : plugin.error
                              }
                              onClick={() =>
                                void addToWorkflow({
                                  repoPathOrUrl: repo.pathOrUrl,
                                  name: workflow.name,
                                })
                              }
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-medium truncate">
                                    {sanitizeDisplayText(workflow.name)}
                                  </div>
                                  {workflow.description && (
                                    <div className="text-sm text-muted truncate">
                                      {sanitizeDisplayText(
                                        workflow.description
                                      )}
                                    </div>
                                  )}
                                </div>
                                {savingTarget === targetKey ? (
                                  <Loader2
                                    size={16}
                                    className="animate-spin shrink-0"
                                  />
                                ) : (
                                  <Plus size={16} className="shrink-0" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                        {list.workflows.length === 0 && (
                          <div className="list-row text-sm text-muted">
                            No workflows in this repository.
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })
            )}
            {repositories !== null && repos.length === 0 && (
              <div className="text-sm text-muted">
                No saved workflow repositories are available.
              </div>
            )}
            {repositories !== null &&
              repos.length > 0 &&
              workflowListsLoaded &&
              !hasValidWorkflow && (
                <div className="text-sm text-muted">
                  No valid persisted workflows are available.
                </div>
              )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
