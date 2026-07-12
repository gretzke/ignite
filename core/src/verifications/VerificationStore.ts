import fs from 'node:fs/promises';
import path from 'node:path';
import type { VerificationTask } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
export type NewTask = Omit<
  VerificationTask,
  'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'status'
> &
  Partial<
    Pick<
      VerificationTask,
      'id' | 'createdAt' | 'updatedAt' | 'attempts' | 'status'
    >
  >;
type File = { schemaVersion: 1; tasks: VerificationTask[] };
const LIVE_TERMINAL = [
  'verified',
  'already-verified',
  'failed',
  'cancelled',
  'superseded',
];
const empty = (): File => ({ schemaVersion: 1, tasks: [] });
export class VerificationStore {
  private fsys = FileSystem.getInstance();
  private base: string;
  private queues = new Map<string, Promise<void>>();
  constructor(deps?: { baseDir?: string; randomUUID?: () => string }) {
    this.base = deps?.baseDir ?? this.fsys.getIgniteHome();
    this.uuid = deps?.randomUUID ?? (() => crypto.randomUUID());
  }
  private uuid: () => string;
  async create(profileId: string, input: NewTask) {
    return this.serial(profileId, async (file) => {
      const now = new Date().toISOString();
      const task: VerificationTask = {
        ...input,
        id: input.id ?? this.uuid(),
        status: input.status ?? 'queued',
        attempts: input.attempts ?? [],
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      } as VerificationTask;
      file.tasks.push(task);
      return task;
    });
  }
  async mutate(
    profileId: string,
    id: string,
    fn: (task: VerificationTask) => void
  ) {
    return this.serial(profileId, async (file) => {
      const task = file.tasks.find((t) => t.id === id);
      if (!task)
        throw Object.assign(new Error(`Verification ${id} not found`), {
          code: 'VERIFICATION_NOT_FOUND',
        });
      const next = structuredClone(task);
      fn(next);
      next.updatedAt = new Date().toISOString();
      Object.assign(task, next);
      return structuredClone(task);
    });
  }
  async list(
    profileId: string,
    filter?: { runId?: string; status?: string }
  ): Promise<VerificationTask[]> {
    const data = await this.read(profileId);
    return data.tasks
      .filter(
        (task) =>
          (!filter?.runId ||
            ('runId' in task.origin && task.origin.runId === filter.runId)) &&
          (!filter?.status || task.status === filter.status)
      )
      .map((task) => structuredClone(task));
  }
  // Atomic dedupe/supersede/create for one enqueue key. Runs inside a single
  // serialized store operation so concurrent enqueues cannot both observe
  // "no live task" (TOCTOU) and double-submit.
  async upsertLive(
    profileId: string,
    input: NewTask
  ): Promise<{
    task: VerificationTask;
    superseded?: VerificationTask;
    existing: boolean;
  }> {
    return this.serial(profileId, async (file) => {
      const live = file.tasks.find(
        (t) =>
          t.chainId === input.chainId &&
          t.address.toLowerCase() === input.address.toLowerCase() &&
          t.explorer.entryId === input.explorer.entryId &&
          !LIVE_TERMINAL.includes(t.status)
      );
      let superseded: VerificationTask | undefined;
      if (live) {
        const identical =
          live.bundleHash === input.bundleHash &&
          JSON.stringify(live.explorer) === JSON.stringify(input.explorer);
        if (identical) {
          return { task: structuredClone(live), existing: true };
        }
        live.status = 'superseded';
        live.detail = 'superseded by newer verification';
        live.updatedAt = new Date().toISOString();
        superseded = structuredClone(live);
      }
      const now = new Date().toISOString();
      const task: VerificationTask = {
        ...input,
        id: input.id ?? this.uuid(),
        status: input.status ?? 'queued',
        attempts: input.attempts ?? [],
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      } as VerificationTask;
      file.tasks.push(task);
      return { task: structuredClone(task), superseded, existing: false };
    });
  }

  async findLive(
    profileId: string,
    key: { chainId: number; address: string; explorerEntryId: string }
  ): Promise<VerificationTask | undefined> {
    return (await this.list(profileId)).find(
      (t) =>
        t.chainId === key.chainId &&
        t.address.toLowerCase() === key.address.toLowerCase() &&
        t.explorer.entryId === key.explorerEntryId &&
        !LIVE_TERMINAL.includes(t.status)
    );
  }
  private file(profile: string) {
    return path.join(
      this.base,
      'profiles',
      profile,
      'verifications',
      'tasks.json'
    );
  }
  private async read(profile: string): Promise<File> {
    const p = this.file(profile);
    if (!(await this.fsys.fileExists(p))) return empty();
    try {
      const v = await this.fsys.readJsonFile<unknown>(p);
      if (
        !v ||
        typeof v !== 'object' ||
        (v as File).schemaVersion !== 1 ||
        !Array.isArray((v as File).tasks) ||
        // Shallow per-task shape check: a single malformed entry (e.g. null)
        // must quarantine the file, not crash every later list()/mutate().
        !(v as File).tasks.every(
          (t) =>
            !!t &&
            typeof t === 'object' &&
            typeof t.id === 'string' &&
            typeof t.status === 'string' &&
            typeof t.address === 'string' &&
            Array.isArray(t.attempts) &&
            !!t.explorer &&
            typeof t.explorer.entryId === 'string'
        )
      )
        throw new Error('schema');
      // Read-migration: early D4 run-origin tasks stored the constructor
      // tail bare (or '' for argless deploys), which fails the 0x-prefixed
      // wire schema and 500s every response embedding the task.
      for (const task of (v as File).tasks) {
        const tail = task.encodedConstructorArgs;
        if (typeof tail === 'string' && !tail.startsWith('0x')) {
          task.encodedConstructorArgs = `0x${tail}`;
        }
      }
      return v as File;
    } catch {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: quarantine sidecar within ~/.ignite
      await fs.rename(p, `${p}.bad`).catch(() => {});
      return empty();
    }
  }
  private async serial<T>(profile: string, fn: (file: File) => Promise<T>) {
    const prev = this.queues.get(profile) ?? Promise.resolve();
    const current = prev
      .catch(() => undefined)
      .then(async () => {
        const file = await this.read(profile);
        const result = await fn(file);
        await this.fsys.writeJsonFile(this.file(profile), file);
        return result;
      });
    this.queues.set(
      profile,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    return current;
  }
}
