// Durable profile-scoped deployment run records. All run changes pass through
// mutate(), which serializes load/modify/write so a stale snapshot cannot
// overwrite a newer transition.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunRecord, RunSummary } from '@ignite/api';
import { RUN_ID_PATTERN, RunRecordSchema } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';

export class RunStore {
  private readonly baseDir: string;
  private readonly fileSystem: Pick<
    FileSystem,
    'fileExists' | 'readJsonFile' | 'writeJsonFile'
  >;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(deps?: { baseDir?: string }) {
    const fileSystem = FileSystem.getInstance();
    this.baseDir = deps?.baseDir ?? fileSystem.getIgniteHome();
    this.fileSystem = fileSystem;
  }

  async create(run: RunRecord): Promise<void> {
    await this.queued(run.profileId, async () => {
      const existing = await this.findByIdempotencyKey(
        run.profileId,
        run.idempotencyKey
      );
      if (existing)
        throw new Error(
          `A deployment run already exists for idempotency key ${run.idempotencyKey}`
        );
      const file = this.runPath(run.profileId, run.id);
      if (await this.fileSystem.fileExists(file))
        throw new Error(`Deployment run ${run.id} already exists`);
      RunRecordSchema.parse(run);
      await this.fileSystem.writeJsonFile(file, run);
    });
  }

  async findByIdempotencyKey(
    profileId: string,
    key: string
  ): Promise<RunRecord | undefined> {
    const entries = await this.readProfileRuns(profileId, false);
    return entries.find((entry) => entry.idempotencyKey === key);
  }

  async get(profileId: string, runId: string): Promise<RunRecord | undefined> {
    const file = this.runPath(profileId, runId);
    if (!(await this.fileSystem.fileExists(file))) return undefined;
    return this.readRun(file);
  }

  async list(
    profileId: string
  ): Promise<{ runs: RunSummary[]; unreadable: string[] }> {
    const dir = this.runsDir(profileId);
    const unreadable = new Set<string>();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const runs: RunSummary[] = [];
    for (const entry of entries.sort()) {
      if (entry.endsWith('.json.bad')) {
        unreadable.add(entry.slice(0, -'.json.bad'.length));
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      try {
        const record = await this.readRun(path.join(dir, entry));
        runs.push(toSummary(record));
      } catch {
        unreadable.add(entry.slice(0, -'.json'.length));
      }
    }
    return { runs, unreadable: [...unreadable].sort() };
  }

  async mutate(
    profileId: string,
    runId: string,
    fn: (run: RunRecord) => void
  ): Promise<RunRecord> {
    let result!: RunRecord;
    const operation = async () => {
      const file = this.runPath(profileId, runId);
      const current = await this.readRun(file);
      // Work on a detached record. If the mutator or schema validation fails,
      // no write has occurred and the prior atomic snapshot remains intact.
      const next = globalThis.structuredClone(current);
      fn(next);
      RunRecordSchema.parse(next);
      await this.fileSystem.writeJsonFile(file, next);
      result = next;
    };
    await this.queued(profileId, operation);
    return result;
  }

  private async queued<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(
      key,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    return current;
  }

  async recoverStartup(): Promise<RunRecord[]> {
    const profilesDir = path.join(this.baseDir, 'profiles');
    let profileIds: string[] = [];
    try {
      // Only directories are profiles: Finder drops .DS_Store (and other
      // tools drop plain files) into profiles/, and treating one as a
      // profileId makes the runs-dir scan throw ENOTDIR at startup.
      profileIds = (await fs.readdir(profilesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const recovered: RunRecord[] = [];
    for (const profileId of profileIds.sort()) {
      const dir = this.runsDir(profileId);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(dir, entry);
        let record: RunRecord;
        try {
          record = await this.readRun(file);
        } catch {
          await this.quarantine(file);
          continue;
        }
        const changed = claimInterruptedLanes(record);
        if (changed) {
          await this.fileSystem.writeJsonFile(file, record);
          recovered.push(record);
        }
      }
    }
    return recovered;
  }

  /** Valid records across profiles, used by durable outbox reconciliation. */
  async listAllRuns(): Promise<RunRecord[]> {
    const profilesDir = path.join(this.baseDir, 'profiles');
    let profileIds: string[] = [];
    try {
      profileIds = (await fs.readdir(profilesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const records: RunRecord[] = [];
    for (const profileId of profileIds)
      records.push(...await this.readProfileRuns(profileId, false));
    return records;
  }

  private runsDir(profileId: string): string {
    return path.join(
      this.baseDir,
      'profiles',
      profileId,
      'deployments',
      'runs'
    );
  }

  private runPath(profileId: string, runId: string): string {
    if (!RUN_ID_PATTERN.test(runId))
      throw new Error(`Invalid deployment run id: ${runId}`);
    return path.join(this.runsDir(profileId), `${runId}.json`);
  }

  private async readProfileRuns(
    profileId: string,
    quarantine: boolean
  ): Promise<RunRecord[]> {
    const dir = this.runsDir(profileId);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(dir, entry);
      try {
        records.push(await this.readRun(file));
      } catch {
        if (quarantine) await this.quarantine(file);
      }
    }
    return records;
  }

  private async readRun(file: string): Promise<RunRecord> {
    const value = await this.fileSystem.readJsonFile<unknown>(file);
    return RunRecordSchema.parse(value);
  }

  private async quarantine(file: string): Promise<void> {
    await fs.rename(file, `${file}.bad`);
  }
}

function claimInterruptedLanes(run: RunRecord): boolean {
  let changed = false;
  for (const lane of Object.values(run.lanes)) {
    if (lane.status === 'completed' || lane.status === 'aborted') continue;
    // A lane that was already durably paused keeps its original pause reason
    // and error — re-stamping it as interrupted would destroy the context the
    // user needs to resolve it (and widen the allowed verb set incorrectly).
    if (lane.status === 'paused') continue;
    const firstNonTerminal = lane.steps.findIndex(
      (step) => !['confirmed', 'skipped'].includes(step.status)
    );
    lane.currentStepIndex =
      firstNonTerminal < 0 ? lane.steps.length : firstNonTerminal;
    lane.status = 'paused';
    lane.pause = {
      reason: 'interrupted',
      stepIndex: lane.currentStepIndex,
      error: 'Deployment execution was interrupted by a restart',
      attemptId:
        lane.steps[lane.currentStepIndex]?.attempts.at(-1)?.id ?? 'recovery',
    };
    changed = true;
  }
  if (changed) run.status = 'paused';
  return changed;
}

function toSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    profileId: run.profileId,
    name: run.name,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    chains: Object.values(run.lanes).map((lane) => lane.chainId),
    ...(run.workflow ? { workflow: { name: run.workflow.name } } : {}),
  };
}
