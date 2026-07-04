import { describe, it, expect, beforeEach, vi } from 'vitest';

const spawned = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
  unref: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawned.calls.push({ cmd, args, opts });
    return { unref: spawned.unref };
  }),
}));

import {
  ContainerOrchestrator,
  ContainerLifecycle,
} from '../../plugins/containers/ContainerOrchestrator.js';

function freshOrchestrator(): ContainerOrchestrator {
  (
    ContainerOrchestrator as unknown as { instance?: ContainerOrchestrator }
  ).instance = undefined;
  return ContainerOrchestrator.getInstance();
}

function seedContainers(
  orchestrator: ContainerOrchestrator,
  entries: Record<string, ContainerLifecycle>
) {
  const managed = (
    orchestrator as unknown as {
      managedContainers: Map<string, ContainerLifecycle>;
    }
  ).managedContainers;
  for (const [name, lifecycle] of Object.entries(entries)) {
    managed.set(name, lifecycle);
  }
  return managed;
}

describe('ContainerOrchestrator.cleanupDetached', () => {
  beforeEach(() => {
    spawned.calls = [];
    spawned.unref.mockClear();
  });

  it('hands container shutdown to a detached process and stops tracking', () => {
    const orchestrator = freshOrchestrator();
    const managed = seedContainers(orchestrator, {
      'ignite-repo-local-foo-abc-default': ContainerLifecycle.PERSISTENT,
      'ignite-repo-local-bar-def-default-session': ContainerLifecycle.SESSION,
    });

    orchestrator.cleanupDetached();

    expect(spawned.calls).toHaveLength(1);
    const { opts, args } = spawned.calls[0];
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    // The child must be unref'd so the CLI can exit without waiting for it
    expect(spawned.unref).toHaveBeenCalled();

    const script = args.join(' ');
    // Both containers get stopped...
    expect(script).toContain('ignite-repo-local-foo-abc-default');
    expect(script).toContain('ignite-repo-local-bar-def-default-session');
    // ...but only the session container is removed
    expect(script).toMatch(/rm[^;]*ignite-repo-local-bar-def-default-session/);
    expect(script).not.toMatch(/rm[^;]*ignite-repo-local-foo-abc-default /);

    expect(managed.size).toBe(0);
  });

  it('does nothing when no containers are tracked', () => {
    const orchestrator = freshOrchestrator();
    orchestrator.cleanupDetached();
    expect(spawned.calls).toHaveLength(0);
  });
});
