// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { WorkflowCheckUpdatesData, WorkflowSummary } from '@ignite/api';
import {
  workflowsReducer,
  workflowListRequested,
  workflowListLoaded,
  workflowListFailed,
  workflowInstallStarted,
  workflowInstallFailed,
  workflowInstallSucceeded,
  workflowUpdatesLoaded,
  workflowOriginsApprovalRequested,
  workflowOriginsApprovalCleared,
} from '../workflowsSlice';

const summary: WorkflowSummary = { name: 'release', valid: true, sourceCount: 2 };

describe('workflowsSlice', () => {
  it('tracks per-repository listings including truncation and failures', () => {
    let state = workflowsReducer(undefined, workflowListRequested('/repo'));
    expect(state.byRepo['/repo']).toMatchObject({ loading: true, workflows: [] });
    state = workflowsReducer(state, workflowListLoaded({ repoPathOrUrl: '/repo', workflows: [summary], truncated: true }));
    expect(state.byRepo['/repo']).toEqual({ loading: false, workflows: [summary], truncated: true });
    state = workflowsReducer(state, workflowListFailed({ repoPathOrUrl: '/repo', error: 'offline' }));
    expect(state.byRepo['/repo']).toMatchObject({ loading: false, error: 'offline' });
  });

  it('keeps resolve state and an origin approval retry scoped to a workflow', () => {
    const key = { repoPathOrUrl: '/repo', name: 'release' };
    let state = workflowsReducer(undefined, workflowInstallStarted({ ...key, jobId: 'job-1' }));
    state = workflowsReducer(state, workflowOriginsApprovalRequested({ ...key, origins: ['https://a.test/x', 'https://b.test/y'] }));
    expect(state.originApproval).toEqual({ ...key, origins: ['https://a.test/x', 'https://b.test/y'] });
    state = workflowsReducer(state, workflowOriginsApprovalCleared());
    state = workflowsReducer(state, workflowInstallSucceeded(key));
    expect(state.installByKey['/repo\0release'].status).toBe('succeeded');
    state = workflowsReducer(state, workflowInstallFailed({ ...key, error: 'failed' }));
    expect(state.installByKey['/repo\0release']).toMatchObject({ status: 'failed', error: 'failed' });
  });

  it('stores update reports per workflow', () => {
    const report: WorkflowCheckUpdatesData = { docHash: 'a'.repeat(64), sources: [], plugins: [] };
    const state = workflowsReducer(undefined, workflowUpdatesLoaded({ repoPathOrUrl: '/repo', name: 'release', report }));
    expect(state.updatesByKey['/repo\0release'].report).toEqual(report);
  });
});
