// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrphanVersionGroupCard, VersionRows } from '../VersionGroupCard';

const version = {
  url: 'https://example.test/contracts.git',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
  refLabel: 'v1.2.3',
  refKind: 'tag' as const,
  frameworks: [
    {
      id: 'foundry',
      name: 'Foundry',
      compiledAt: '2026-07-18T00:00:00.000Z',
    },
  ],
  lastUsedAt: '2026-07-18T00:00:00.000Z',
};

describe('repository version groups', () => {
  it('renders version identity, framework, compile state, and remove control', () => {
    const html = renderToStaticMarkup(
      <VersionRows
        url="https://example.test/contracts.git"
        versions={[version]}
        onRemove={() => undefined}
      />
    );

    expect(html).toContain('v1.2.3');
    expect(html).toContain('abcdef012345');
    expect(html).toContain('Foundry');
    expect(html).toContain('Compiled');
    expect(html).toContain('Remove');
  });

  it('renders a persistent failed state and retry control for a failed add', () => {
    const html = renderToStaticMarkup(
      <VersionRows
        url="https://example.test/contracts.git"
        versions={[version]}
        versionAddJobs={{
          [`${version.url}\u0000${version.commit}`]: {
            jobId: 'job-failed',
            status: 'failed',
            error: 'Dependency installation failed',
          },
        }}
        onRemove={() => undefined}
        onRetry={() => undefined}
      />
    );

    expect(html).toContain('Failed');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Detecting');
    expect(html).not.toContain('Compiling');
  });

  it('renders orphan URL groups with an overflow action menu', () => {
    const html = renderToStaticMarkup(
      <OrphanVersionGroupCard
        group={{
          url: 'https://example.test/contracts.git',
          versions: [version],
        }}
        onAddVersion={() => undefined}
        onRemove={() => undefined}
      />
    );

    expect(html).toContain('https://example.test/contracts.git');
    expect(html).toContain('Repository version actions');
    expect(html).not.toContain('Add version');
  });
});
