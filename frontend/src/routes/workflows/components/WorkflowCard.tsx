import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Download,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { WorkflowSummary } from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';
import InstallPluginDialog from '../../../components/plugins/InstallPluginDialog';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import { workflowsApi } from '../../../store/features/workflows/workflowsApi';
import {
  selectWorkflowDocument,
  selectWorkflowInstall,
  selectWorkflowStatus,
  selectWorkflowUpdates,
  workflowOriginsApprovalRequested,
} from '../../../store/features/workflows/workflowsSlice';
import {
  selectPluginRows,
  type PluginRow,
} from '../../../store/features/plugins/pluginsSlice';
import {
  acceptWorkflowPinUpdate,
  hydrateWorkflowDraft,
} from '../../../store/features/deployments/deployDraftSlice';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';
import UpdateDiffDialog from './UpdateDiffDialog';

export default function WorkflowCard({
  repoPathOrUrl,
  workflow,
}: {
  repoPathOrUrl: string;
  workflow: WorkflowSummary;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const documentState = useAppSelector((state) =>
    selectWorkflowDocument(state, repoPathOrUrl, workflow.name)
  );
  const status = useAppSelector((state) =>
    selectWorkflowStatus(state, repoPathOrUrl)
  );
  const entry = status?.workflows.find((item) => item.name === workflow.name);
  const install = useAppSelector((state) =>
    selectWorkflowInstall(state, repoPathOrUrl, workflow.name)
  );
  const updates = useAppSelector((state) =>
    selectWorkflowUpdates(state, repoPathOrUrl, workflow.name)
  );
  const profileId = useAppSelector((state) => state.profiles.currentId);
  const plugins = useAppSelector(selectPluginRows);
  const installJob = useAppSelector((state) =>
    install?.jobId ? state.jobs.byId[install.jobId] : undefined
  );
  const [diffOpen, setDiffOpen] = useState(false);
  const [pluginId, setPluginId] = useState<string | null>(null);
  const installRequested = useRef(false);
  const [installPending, setInstallPending] = useState(false);

  useEffect(() => {
    if (workflow.valid && !documentState) {
      dispatch(workflowsApi.get(repoPathOrUrl, workflow.name));
    }
  }, [dispatch, documentState, repoPathOrUrl, workflow.name, workflow.valid]);

  useEffect(() => {
    if (install?.status === 'queued' || install?.status === 'running') return;
    installRequested.current = false;
    setInstallPending(false);
  }, [install]);

  if (!workflow.valid) {
    return (
      <div className="list-row items-start">
        <AlertCircle size={18} className="text-err shrink-0 mt-0.5" />
        <div>
          <div className="font-medium mono-data">
            {sanitizeDisplayText(workflow.name)}.json
          </div>
          <div className="text-sm text-err mt-1">
            {sanitizeDisplayText(workflow.error ?? 'Invalid workflow document')}
          </div>
        </div>
      </div>
    );
  }

  const busy =
    entry?.attempt?.status === 'running' ||
    installPending ||
    install?.status === 'queued' ||
    install?.status === 'running';
  const selectedPlugin = documentState?.document.requiredPlugins.find(
    (plugin) => plugin.id === pluginId
  );
  const selectedInstalledPlugin = plugins.find(
    (plugin) => plugin.pluginId === pluginId
  );
  const managePlugin = (plugin: PluginRow | undefined) => {
    if (!plugin) return undefined;
    return {
      pluginId: plugin.pluginId,
      name: plugin.name ?? plugin.pluginId,
      ...(selectedPlugin?.source?.kind === 'git'
        ? { url: selectedPlugin.source.url }
        : {}),
      currentRef:
        selectedPlugin?.source?.kind === 'git' &&
        selectedPlugin.source.track?.mode === 'release'
          ? selectedPlugin.source.track.version
          : undefined,
    };
  };
  const suppressStateAction = status?.loading && !entry;
  const startInstall = (onDocumentChanged?: () => void) => {
    if (!entry?.docHash || installRequested.current) return;
    installRequested.current = true;
    setInstallPending(true);
    dispatch(
      workflowsApi.installWorkflow(
        {
          repoPathOrUrl,
          name: workflow.name,
          expectedDocHash: entry.docHash,
        },
        profileId ?? undefined,
        onDocumentChanged
      )
    );
  };
  const openInstall = () => startInstall();
  const confirmUpdate = () => {
    setDiffOpen(false);
    startInstall(() => setDiffOpen(false));
  };

  return (
    <div className="list-row block">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-semibold">
            {sanitizeDisplayText(workflow.name)}
          </div>
          {workflow.description && (
            <p className="text-sm text-muted mt-1">
              {sanitizeDisplayText(workflow.description)}
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="pill rounded-full px-2 py-0.5">
              {workflow.sourceCount ?? 0} sources
            </span>
            <span className="pill rounded-full px-2 py-0.5">
              {workflow.stepCount ?? 0} steps
            </span>
            {(workflow.hooks ?? []).map((hook) => (
              <span
                key={hook}
                className="pill pill-primary rounded-full px-2 py-0.5"
              >
                {sanitizeDisplayText(hook)}
              </span>
            ))}
          </div>
          {documentState && (
            <div className="mt-3 space-y-1 text-xs">
              {documentState.document.sources.map((source) =>
                source.origin === 'contract-type' ? null : (
                  <div key={source.id}>
                    <span className="mono-data">
                      {sanitizeDisplayText(source.contractName)}
                    </span>
                    {source.repo.ref
                      ? ` @ ${sanitizeDisplayText(source.repo.ref)}`
                      : ` @ ${sanitizeDisplayText(source.repo.commit.slice(0, 7))}`}
                  </div>
                )
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {documentState.document.requiredPlugins.map((required) => {
                  const readiness = entry?.plugins?.find(
                    (plugin) => plugin.id === required.id
                  );
                  const installed = plugins.find(
                    (plugin) => plugin.pluginId === required.id
                  );
                  const pluginState =
                    readiness?.status ??
                    (!installed
                      ? 'missing'
                      : installed.version === required.version
                        ? 'installed'
                        : 'version-mismatch');
                  return (
                    <span
                      key={required.id}
                      className={`pill rounded-full px-2 py-0.5 ${pluginState === 'installed' ? 'pill-success' : 'pill-warning'}`}
                    >
                      {sanitizeDisplayText(required.id)}@
                      {sanitizeDisplayText(required.version)} ·{' '}
                      {sanitizeDisplayText(pluginState)}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {entry?.installState === 'not-installed' &&
            entry.sources
              ?.filter((source) => !source.ready && source.reason)
              .map((source) => (
                <span
                  key={source.id}
                  className="pill pill-warning rounded-full px-2 py-0.5 mr-2 mt-2 inline-block text-xs"
                >
                  {sanitizeDisplayText(source.id)}:{' '}
                  {sanitizeDisplayText(source.reason!)}
                </span>
              ))}
        </div>
        <div className="flex gap-2 shrink-0">
          {!busy &&
            !suppressStateAction &&
            entry?.installState === 'not-installed' && (
              <button
                className="btn btn-primary"
                disabled={!entry.docHash}
                onClick={openInstall}
              >
                <Download size={15} /> Install
              </button>
            )}
          {!busy &&
            !suppressStateAction &&
            entry?.installState === 'out-of-sync' && (
              <button
                className="btn btn-primary"
                disabled={!entry.diff || !entry.docHash}
                onClick={() => setDiffOpen(true)}
              >
                <RefreshCw size={15} /> Update
              </button>
            )}
          {!busy && !suppressStateAction && entry?.installState === 'ready' && (
            <button
              className="btn btn-primary"
              onClick={() =>
                navigate(
                  `/deploy?workflowRepo=${encodeURIComponent(repoPathOrUrl)}&workflow=${encodeURIComponent(workflow.name)}`
                )
              }
            >
              <Play size={15} /> Run
            </button>
          )}
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={() =>
              navigate(
                `/workflows/edit?workflowRepo=${encodeURIComponent(repoPathOrUrl)}&workflow=${encodeURIComponent(workflow.name)}`
              )
            }
          >
            <Pencil size={15} /> Edit
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy || updates?.loading}
            onClick={() =>
              workflowsApi
                .checkUpdates(repoPathOrUrl, workflow.name)
                .forEach((action) => dispatch(action))
            }
          >
            <RefreshCw
              size={15}
              className={updates?.loading ? 'animate-spin' : ''}
            />{' '}
            Check for new versions
          </button>
        </div>
      </div>
      {busy && (
        <div className="text-sm text-muted mt-3 flex items-center gap-2">
          <Loader2 size={15} className="animate-spin" /> Installing…
          {installJob?.logTail.at(-1) && (
            <span className="mono-data">
              {sanitizeDisplayText(
                decodeUrlEncodingForDisplay(installJob.logTail.at(-1)!)
              )}
            </span>
          )}
        </div>
      )}
      {(entry?.attempt?.status === 'failed' ||
        entry?.attempt?.status === 'interrupted') && (
        <div className="mt-3 text-sm text-err space-y-1">
          <div>{sanitizeDisplayText(entry.attempt.error)}</div>
          {entry.attempt.failedSources?.map((source) => (
            <div key={source.id}>
              {sanitizeDisplayText(source.id)}:{' '}
              {sanitizeDisplayText(source.reason)}
              {source.code && ` (${sanitizeDisplayText(source.code)})`}
            </div>
          ))}
        </div>
      )}
      {install?.error && (
        <div className="mt-3 text-sm text-err">
          {sanitizeDisplayText(install.error)}
        </div>
      )}
      {updates?.report && (
        <div className="mt-4 card-milky p-3 text-sm space-y-2">
          {updates.report.sources.length === 0 &&
            updates.report.plugins.length === 0 && (
              <div className="text-muted">Everything is up to date.</div>
            )}
          {updates.report.sources.map((row) => {
            const requiredSource = documentState?.document.sources.find(
              (source) => source.id === row.sourceId
            );
            if (requiredSource?.origin === 'contract-type') return null;
            const upgrade = row.upgrades?.at(-1);
            const commit = upgrade?.commit ?? row.latestCommit;
            const ref = upgrade?.ref ?? requiredSource?.repo.ref;
            return (
              <div
                key={row.sourceId}
                className="flex items-center justify-between gap-3"
              >
                <span>
                  <span className="mono-data">
                    {sanitizeDisplayText(row.sourceId)}
                  </span>
                  :{' '}
                  {row.status === 'tag-retargeted'
                    ? 'tag retargeted'
                    : row.status === 'tag-deleted'
                      ? 'tag vanished'
                      : row.status === 'branch-moved'
                        ? 'branch moved'
                        : row.status === 'upgrade-available'
                          ? `upgrade available (${row.upgrades?.map((item) => sanitizeDisplayText(item.ref)).join(', ')})`
                          : row.status === 'approval-required'
                            ? `approval required (${sanitizeDisplayText(row.origin ?? '')})`
                            : sanitizeDisplayText(
                                decodeUrlEncodingForDisplay(
                                  row.error ?? row.status
                                )
                              )}
                </span>
                {row.status === 'approval-required' && row.origin ? (
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      dispatch(
                        workflowOriginsApprovalRequested({
                          repoPathOrUrl,
                          name: workflow.name,
                          origins: [row.origin!],
                          retry: 'updates',
                        })
                      )
                    }
                  >
                    Approve origin
                  </button>
                ) : (
                  commit &&
                  documentState &&
                  row.status !== 'up-to-date' &&
                  row.status !== 'error' && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        dispatch(
                          hydrateWorkflowDraft({
                            repoPathOrUrl,
                            name: workflow.name,
                            docHash: documentState.docHash,
                            document: documentState.document,
                          })
                        );
                        dispatch(
                          acceptWorkflowPinUpdate({
                            sourceId: row.sourceId,
                            commit,
                            ...(ref
                              ? {
                                  ref,
                                  refKind: upgrade
                                    ? 'tag'
                                    : requiredSource?.repo.refKind,
                                }
                              : {}),
                          })
                        );
                        navigate(
                          `/workflows/edit?workflowRepo=${encodeURIComponent(repoPathOrUrl)}&workflow=${encodeURIComponent(workflow.name)}&acceptDocHash=${encodeURIComponent(updates.report!.docHash)}&acceptSourceId=${encodeURIComponent(row.sourceId)}&acceptCommit=${encodeURIComponent(commit)}${ref ? `&acceptRef=${encodeURIComponent(ref)}&acceptRefKind=${encodeURIComponent(upgrade ? 'tag' : (requiredSource?.repo.refKind ?? 'branch'))}` : ''}`
                        );
                      }}
                    >
                      Accept in editor
                    </button>
                  )
                )}
              </div>
            );
          })}
          {updates.report.plugins.map((row) => {
            const required = documentState?.document.requiredPlugins.find(
              (item) => item.id === row.id
            );
            const actionLabel =
              row.status === 'missing'
                ? 'Install'
                : row.status === 'version-mismatch' || row.updateAvailable
                  ? 'Update'
                  : undefined;
            return (
              <div
                key={row.id}
                className="flex items-center justify-between gap-3"
              >
                <span>
                  <span className="mono-data">
                    {sanitizeDisplayText(row.id)}
                  </span>
                  : {sanitizeDisplayText(row.status)}
                  {row.updateAvailable ? ' · update available' : ''}
                </span>
                {actionLabel && required && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setPluginId(required.id)}
                  >
                    {actionLabel}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {entry?.diff && (
        <UpdateDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          diff={entry.diff}
          onConfirm={confirmUpdate}
        />
      )}
      <InstallPluginDialog
        open={pluginId !== null}
        onOpenChange={(open) => !open && setPluginId(null)}
        requiredPlugin={selectedPlugin}
        manage={managePlugin(selectedInstalledPlugin)}
      />
    </div>
  );
}
