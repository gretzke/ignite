// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactBrowserSelectedActions } from '../ArtifactBrowser';

describe('ArtifactBrowser workflow action', () => {
  it('disables Add to workflow outside version-scoped browsing', () => {
    const html = renderToStaticMarkup(
      <ArtifactBrowserSelectedActions
        selectedCount={1}
        draftActive={false}
        onAddToDeployment={() => undefined}
        onAddToWorkflow={() => undefined}
      />
    );

    expect(html).toContain('Add to workflow');
    expect(html).toContain('disabled=""');
  });

  it('enables Add to workflow for a selected pinned version', () => {
    const html = renderToStaticMarkup(
      <ArtifactBrowserSelectedActions
        selectedCount={1}
        draftActive={false}
        pin={{
          url: 'https://example.test/contracts.git',
          commit: 'a'.repeat(40),
        }}
        onAddToDeployment={() => undefined}
        onAddToWorkflow={() => undefined}
      />
    );

    const workflowButton = html.match(
      /<button[^>]*>Add to workflow<\/button>/
    )?.[0];
    expect(workflowButton).toBeDefined();
    expect(workflowButton).not.toContain('disabled');
  });
});
