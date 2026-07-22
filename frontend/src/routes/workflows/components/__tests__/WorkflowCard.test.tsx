// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  WorkflowInstallDiff,
  WorkflowStatusEntry,
  WorkflowSummary,
} from '@ignite/api';
import WorkflowCard from '../WorkflowCard';
import { UpdateDiffRows } from '../UpdateDiffDialog';
import { jobsReducer } from '../../../../store/features/jobs/jobsSlice';
import { pluginsReducer } from '../../../../store/features/plugins/pluginsSlice';
import {
  profilesReducer,
  setCurrentProfile,
} from '../../../../store/features/profiles/profilesSlice';
import {
  workflowDocumentLoaded,
  workflowStatusLoaded,
  workflowsReducer,
} from '../../../../store/features/workflows/workflowsSlice';

const repoPathOrUrl = '/repo';
const docHash = 'a'.repeat(64);
const summary: WorkflowSummary = {
  name: 'release',
  valid: true,
  description: 'release\u202e workflow',
  sourceCount: 1,
  stepCount: 1,
  hooks: ['hook\u0000name'],
};

function renderCard(entry: WorkflowStatusEntry): string {
  const store = configureStore({
    reducer: {
      workflows: workflowsReducer,
      profiles: profilesReducer,
      plugins: pluginsReducer,
      jobs: jobsReducer,
    },
  });
  store.dispatch(setCurrentProfile('profile-a'));
  store.dispatch(
    workflowStatusLoaded({
      profileId: 'profile-a',
      repoPathOrUrl,
      workflows: [entry],
    })
  );
  store.dispatch(
    workflowDocumentLoaded({
      repoPathOrUrl,
      name: 'release',
      docHash,
      raw: '{}',
      document: {
        schemaVersion: 1,
        sources: [],
        steps: [],
        requiredPlugins: [
          {
            id: 'plugin',
            version: '1.0.0',
            source: { kind: 'git', url: 'https://example.test/plugin' },
          },
        ],
        outputs: { hooks: [] },
      },
    })
  );
  return renderToStaticMarkup(
    <Provider store={store}>
      <MemoryRouter>
        <WorkflowCard repoPathOrUrl={repoPathOrUrl} workflow={summary} />
      </MemoryRouter>
    </Provider>
  );
}

const entry = (
  installState: NonNullable<WorkflowStatusEntry['installState']>,
  attempt: WorkflowStatusEntry['attempt'] = { status: 'idle' }
): WorkflowStatusEntry => ({
  name: 'release',
  valid: true,
  docHash,
  installState,
  attempt,
  sources: [{ id: 'token', ready: false, reason: 'artifact missing' }],
  plugins: [{ id: 'plugin', status: 'missing' }],
  ...(installState === 'out-of-sync'
    ? {
        diff: {
          sourcesAdded: [],
          sourcesRemoved: [],
          sourcesRenamed: [],
          versionsChanged: [],
          artifactsChanged: [],
          sourcesModified: [],
          pluginsChanged: [],
          stepsChanged: false,
          hooksChanged: false,
          formattingOnly: true,
        },
      }
    : {}),
});

describe('WorkflowCard lifecycle states', () => {
  it.each([
    ['not-installed', 'Install'],
    ['out-of-sync', 'Update'],
    ['ready', 'Run'],
  ] as const)(
    'renders %s with %s as its state action',
    (
      installState: NonNullable<WorkflowStatusEntry['installState']>,
      action: string
    ) => {
      const html = renderCard(entry(installState));
      expect(html).toContain(action);
      expect(html).toContain('Edit');
      expect(html).toContain('Check for new versions');
    }
  );

  it('renders progress and no state action while the attempt is running', () => {
    const html = renderCard(
      entry('ready', { status: 'running', jobId: 'job-1' })
    );
    expect(html).toContain('Installing…');
    expect(html).not.toContain(' Install</button>');
    expect(html).not.toContain(' Update</button>');
    expect(html).not.toContain(' Run</button>');
  });

  it.each(['not-installed', 'out-of-sync', 'ready'] as const)(
    'renders failed attempt details alongside %s',
    (installState: NonNullable<WorkflowStatusEntry['installState']>) => {
      const html = renderCard(
        entry(installState, {
          status: 'failed',
          error: 'install failed',
          failedSources: [
            {
              id: 'token',
              reason: 'missing artifact',
              code: 'ARTIFACT_NOT_FOUND',
            },
          ],
          atDocHash: docHash,
        })
      );
      expect(html).toContain('install failed');
      expect(html).toContain('ARTIFACT_NOT_FOUND');
    }
  );

  it('sanitizes workflow-list text and shows degraded source reasons', () => {
    const html = renderCard(entry('not-installed'));
    expect(html).toContain('release workflow');
    expect(html).toContain('hookname');
    expect(html).toContain('token: artifact missing');
    expect(html).not.toContain('\u202e');
  });
});

describe('UpdateDiffDialog', () => {
  const diff: WorkflowInstallDiff = {
    sourcesAdded: [
      {
        id: 'added',
        ready: true,
        canonicalUrl: 'https://example.test/added',
        commit: 'b'.repeat(40),
        artifactPath: 'out/A.json',
      },
    ],
    sourcesRemoved: [{ id: 'removed', ready: true }],
    sourcesRenamed: [
      { from: 'old', to: 'new', detail: { id: 'new', ready: true } },
    ],
    versionsChanged: [
      {
        detail: { id: 'versioned', ready: true },
        from: { ref: 'v1', commit: 'c'.repeat(40) },
        to: { ref: 'v2', commit: 'd'.repeat(40) },
      },
    ],
    artifactsChanged: [
      {
        detail: { id: 'artifact', ready: true },
        from: 'out/Old.json',
        to: 'out/New.json',
      },
    ],
    sourcesModified: [
      {
        detail: { id: 'modified', ready: true },
        changes: ['frameworkId', 'sourcePath'],
      },
    ],
    pluginsChanged: [
      { id: 'plugin', kind: 'version', from: '1.0.0', to: '2.0.0' },
    ],
    stepsChanged: true,
    hooksChanged: true,
    formattingOnly: true,
  };

  it('renders every diff row kind, including source field changes and formatting-only changes', () => {
    const html = renderToStaticMarkup(<UpdateDiffRows diff={diff} />);
    for (const label of [
      'Source added',
      'Source removed',
      'Source renamed',
      'Version changed',
      'Artifact changed',
      'Source modified',
      'Plugin version',
      'Deployment steps changed',
      'Workflow hooks changed',
      'Formatting-only document change',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('frameworkId, sourcePath');
    expect(html).toContain('v1@');
  });
});
