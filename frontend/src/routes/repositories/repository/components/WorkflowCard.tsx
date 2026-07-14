import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Loader2, Play, RefreshCw, Pencil } from 'lucide-react';
import type { WorkflowSummary } from '@ignite/api';
import { useAppDispatch, useAppSelector } from '../../../../store/hooks';
import { workflowsApi } from '../../../../store/features/workflows/workflowsApi';
import {
  selectWorkflowDocument,
  selectWorkflowResolve,
  selectWorkflowUpdates,
  workflowOriginsApprovalRequested,
} from '../../../../store/features/workflows/workflowsSlice';
import { selectPluginRows, pluginsApi } from '../../../../store/features/plugins/pluginsSlice';
import { acceptWorkflowPinUpdate, hydrateWorkflowDraft } from '../../../../store/features/deployments/deployDraftSlice';

export default function WorkflowCard({ repoPathOrUrl, workflow }: { repoPathOrUrl: string; workflow: WorkflowSummary }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const documentState = useAppSelector((state) => selectWorkflowDocument(state, repoPathOrUrl, workflow.name));
  const resolve = useAppSelector((state) => selectWorkflowResolve(state, repoPathOrUrl, workflow.name));
  const updates = useAppSelector((state) => selectWorkflowUpdates(state, repoPathOrUrl, workflow.name));
  const plugins = useAppSelector(selectPluginRows);
  const resolveJob = useAppSelector((state) => resolve?.jobId ? state.jobs.byId[resolve.jobId] : undefined);
  const readinessReady = Boolean(resolve?.result && resolve.result.sources.every((source) => source.status === 'ready') && resolve.result.plugins.every((plugin) => plugin.status === 'installed'));

  useEffect(() => {
    if (workflow.valid && !documentState) dispatch(workflowsApi.get(repoPathOrUrl, workflow.name));
  }, [dispatch, documentState, repoPathOrUrl, workflow.name, workflow.valid]);
  useEffect(() => {
    if (resolve?.status === 'succeeded' && readinessReady) {
      navigate(`/deploy?workflowRepo=${encodeURIComponent(repoPathOrUrl)}&workflow=${encodeURIComponent(workflow.name)}`);
    }
  }, [navigate, readinessReady, repoPathOrUrl, resolve?.status, workflow.name]);

  if (!workflow.valid) {
    return (
      <div className="list-row items-start">
        <AlertCircle size={18} className="text-err shrink-0 mt-0.5" />
        <div><div className="font-medium mono-data">{workflow.name}.json</div><div className="text-sm text-err mt-1">{workflow.error ?? 'Invalid workflow document'}</div></div>
      </div>
    );
  }

  const busy = resolve?.status === 'queued' || resolve?.status === 'running';
  return (
    <div className="list-row block">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-semibold">{workflow.name}</div>
          {workflow.description && <p className="text-sm text-muted mt-1">{workflow.description}</p>}
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="pill rounded-full px-2 py-0.5">{workflow.sourceCount ?? 0} sources</span>
            <span className="pill rounded-full px-2 py-0.5">{workflow.stepCount ?? 0} steps</span>
            {(workflow.defaultChains ?? []).map((chainId) => <span key={chainId} className="pill rounded-full px-2 py-0.5">chain {chainId}</span>)}
            {(workflow.hooks ?? []).map((hook) => <span key={hook} className="pill pill-primary rounded-full px-2 py-0.5">{hook}</span>)}
          </div>
          {documentState && (
            <div className="mt-3 space-y-1 text-xs">
              {documentState.document.sources.map((source) => (
                <div key={source.id}><span className="mono-data">{source.contractName}</span>{source.repo.ref ? ` @ ${source.repo.ref}` : ` @ ${source.repo.commit.slice(0, 7)}`}</div>
              ))}
              <div className="flex flex-wrap gap-2 pt-1">
                {documentState.document.requiredPlugins.map((required) => {
                  const installed = plugins.find((plugin) => plugin.pluginId === required.id);
                  const status = !installed ? 'missing' : installed.version === required.version ? 'installed' : 'version mismatch';
                  return <span key={required.id} className={`pill rounded-full px-2 py-0.5 ${status === 'installed' ? 'pill-success' : 'pill-warning'}`} title={!installed && !required.source ? 'Install manually from Plugins settings' : undefined}>{required.id}@{required.version} · {status}</span>;
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button className="btn btn-primary" disabled={busy} onClick={() => dispatch(workflowsApi.resolve(repoPathOrUrl, workflow.name))}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} {busy ? 'Resolving…' : 'Run'}
          </button>
          <button className="btn btn-secondary" onClick={() => navigate(`/deploy?workflowRepo=${encodeURIComponent(repoPathOrUrl)}&workflow=${encodeURIComponent(workflow.name)}&edit=true`)}><Pencil size={15} /> Edit</button>
          <button className="btn btn-secondary" disabled={updates?.loading} onClick={() => workflowsApi.checkUpdates(repoPathOrUrl, workflow.name).forEach((action) => dispatch(action))}><RefreshCw size={15} className={updates?.loading ? 'animate-spin' : ''} /> Updates</button>
        </div>
      </div>
      {resolve?.status === 'failed' && <div className="text-sm text-err mt-3">{resolve.error}</div>}
      {busy && resolveJob?.logTail.at(-1) && <div className="text-sm text-muted mt-3 mono-data">{resolveJob.logTail.at(-1)}</div>}
      {resolve?.status === 'succeeded' && !readinessReady && resolve.result && <div className="mt-3 text-sm text-warn space-y-1">{resolve.result.sources.filter((source) => source.status === 'failed').map((source) => <div key={source.id}>{source.id}: {source.reason}</div>)}{resolve.result.plugins.filter((plugin) => plugin.status !== 'installed').map((plugin) => <div key={plugin.id}>{plugin.id}: {plugin.status}</div>)}</div>}
      {updates?.report && (
        <div className="mt-4 card-milky p-3 text-sm space-y-2">
          {updates.report.sources.length === 0 && updates.report.plugins.length === 0 && <div className="text-muted">Everything is up to date.</div>}
          {updates.report.sources.map((row) => {
            const requiredSource = documentState?.document.sources.find((source) => source.id === row.sourceId);
            const upgrade = row.upgrades?.at(-1);
            const commit = upgrade?.commit ?? row.latestCommit;
            const ref = upgrade?.ref ?? requiredSource?.repo.ref;
            return <div key={row.sourceId} className="flex items-center justify-between gap-3"><span><span className="mono-data">{row.sourceId}</span>: {row.status === 'tag-retargeted' ? 'tag retargeted' : row.status === 'tag-deleted' ? 'tag vanished' : row.status === 'branch-moved' ? 'branch moved' : row.status === 'upgrade-available' ? `upgrade available (${row.upgrades?.map((item) => item.ref).join(', ')})` : row.status === 'approval-required' ? `approval required (${row.origin})` : row.status}</span>{row.status === 'approval-required' && row.origin ? <button className="btn btn-secondary" onClick={() => dispatch(workflowOriginsApprovalRequested({ repoPathOrUrl, name: workflow.name, origins: [row.origin!], retry: 'updates' }))}>Approve origin</button> : commit && documentState && row.status !== 'up-to-date' && row.status !== 'error' && <button className="btn btn-secondary" onClick={() => { dispatch(hydrateWorkflowDraft({ repoPathOrUrl, name: workflow.name, docHash: documentState.docHash, document: documentState.document })); dispatch(acceptWorkflowPinUpdate({ sourceId: row.sourceId, commit, ...(ref ? { ref, refKind: upgrade ? 'tag' : requiredSource?.repo.refKind } : {}) })); navigate(`/deploy?workflowRepo=${encodeURIComponent(repoPathOrUrl)}&workflow=${encodeURIComponent(workflow.name)}&edit=true`); }}>Accept in editor</button>}</div>;
          })}
          {updates.report.plugins.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <span><span className="mono-data">{row.id}</span>: {row.status}{row.updateAvailable ? ' · update available' : ''}</span>
              {row.status === 'missing' && (() => {
                const source = documentState?.document.requiredPlugins.find((item) => item.id === row.id)?.source;
                if (!source) return <span className="text-muted">Install manually in Plugins</span>;
                return <button className="btn btn-secondary" onClick={() => dispatch(source.kind === 'git' ? pluginsApi.installGit({ url: source.url, ...(source.ref ? { ref: source.ref } : {}), ...(source.track ? { track: source.track } : {}) }) : pluginsApi.install(source.contextDir, source.dockerfile))}>Install</button>;
              })()}
              {row.status === 'version-mismatch' && <button className="btn btn-secondary" onClick={() => dispatch(pluginsApi.update(row.id))}>Update installed plugin</button>}
              {row.updateAvailable && row.status === 'installed' && plugins.some((plugin) => plugin.pluginId === row.id) && <button className="btn btn-secondary" onClick={() => dispatch(pluginsApi.update(row.id))}>Update</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
