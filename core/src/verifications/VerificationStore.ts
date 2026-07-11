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
  async findLive(
    profileId: string,
    key: { chainId: number; address: string; explorerEntryId: string }
  ): Promise<VerificationTask | undefined> {
    return (await this.list(profileId)).find(
      (t) =>
        t.chainId === key.chainId &&
        t.address.toLowerCase() === key.address.toLowerCase() &&
        t.explorer.entryId === key.explorerEntryId &&
        ![
          'verified',
          'already-verified',
          'failed',
          'cancelled',
          'superseded',
        ].includes(t.status)
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
        !Array.isArray((v as File).tasks)
      )
        throw new Error('schema');
      return v as File;
    } catch {
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
