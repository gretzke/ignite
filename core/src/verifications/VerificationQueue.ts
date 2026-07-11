import type {
  CreateVerificationRequest,
  ExplorerTargetSnapshot,
  RunRecord,
  VerificationTask,
} from '@ignite/api';
import { BundleStore } from './BundleStore.js';
import { VerificationStore } from './VerificationStore.js';
import { VerificationEvents } from './events.js';
import { sanitizePluginString } from './sanitize.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
export const SUBMIT_BACKOFF_MS = [
  5_000, 15_000, 45_000, 120_000, 300_000,
] as const;
export const MAX_SUBMIT_ATTEMPTS = 8;
export const POLL_DEADLINE_MS = 30 * 60_000;
export const GLOBAL_CONCURRENCY = 3;
const terminal = [
  'verified',
  'already-verified',
  'failed',
  'cancelled',
  'superseded',
];
export class VerificationQueue {
  private static instance: VerificationQueue;
  readonly events: VerificationEvents;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private executor: Pick<PluginExecutor, 'execute'>;
  constructor(deps?: {
    store?: VerificationStore;
    events?: VerificationEvents;
    executor?: Pick<PluginExecutor, 'execute'>;
  }) {
    this.store = deps?.store ?? new VerificationStore();
    this.events = deps?.events ?? new VerificationEvents();
    this.executor = deps?.executor ?? PluginExecutor.getInstance();
  }
  readonly store: VerificationStore;
  static getInstance() {
    return (this.instance ??= new VerificationQueue());
  }
  static resetInstance() {
    this.instance = undefined as unknown as VerificationQueue;
  }
  subscribe(listener: (profileId: string, event: any) => void) {
    return this.events.subscribe(listener);
  }
  eventsSince(profile: string, epoch: string, after: number) {
    return this.events.eventsSince(profile, epoch, after);
  }
  eventCursor(profile: string) {
    return this.events.cursor(profile);
  }
  async enqueueForConfirmedStep(
    profileId: string,
    run: RunRecord,
    chainId: number,
    stepId: string,
    contractId: string,
    address: string,
    creationTxHash: string,
    encodedConstructorArgs: string
  ) {
    const frozen = run.inputs[contractId];
    if (!frozen?.bundleHash) return;
    for (const explorer of run.explorerTargets?.[String(chainId)] ?? [])
      await this.enqueue(profileId, {
        chainId,
        address,
        bundleHash: frozen.bundleHash,
        encodedConstructorArgs,
        creationTxHash,
        explorer,
        origin: { runId: run.id, stepId, contractId },
      });
  }
  async enqueueManual(
    profileId: string,
    req: CreateVerificationRequest,
    resolved: {
      bundleHash: string;
      explorers: ExplorerTargetSnapshot[];
      encodedConstructorArgs: string;
    }
  ) {
    return Promise.all(
      resolved.explorers.map((explorer) =>
        this.enqueue(profileId, {
          chainId: req.chainId,
          address: req.address,
          bundleHash: resolved.bundleHash,
          encodedConstructorArgs: resolved.encodedConstructorArgs,
          creationTxHash: req.creationTxHash,
          explorer,
          origin: { kind: 'manual' },
        })
      )
    );
  }
  private async enqueue(
    profile: string,
    input: Omit<
      VerificationTask,
      | 'id'
      | 'status'
      | 'attempts'
      | 'createdAt'
      | 'updatedAt'
      | 'detail'
      | 'nextAttemptAt'
      | 'explorerPageUrl'
    >
  ) {
    const old = await this.store.findLive(profile, {
      chainId: input.chainId,
      address: input.address,
      explorerEntryId: input.explorer.entryId,
    });
    if (old) {
      if (
        old.bundleHash === input.bundleHash &&
        JSON.stringify(old.explorer) === JSON.stringify(input.explorer)
      )
        return old;
      await this.change(profile, old.id, (t) => {
        t.status = 'superseded';
        t.detail = 'superseded by newer verification';
      });
    }
    const task = await this.store.create(profile, {
      ...input,
      explorerPageUrl: /^https?:/.test(input.explorer.url)
        ? `${input.explorer.url}/address/${input.address}`
        : undefined,
    });
    this.events.emit(profile, task);
    this.schedule(profile, task, 0);
    return task;
  }
  async retry(profile: string, id: string) {
    const task = await this.change(profile, id, (t) => {
      if (!terminal.includes(t.status))
        throw Object.assign(new Error('Verification is not terminal'), {
          code: 'VERIFICATION_NOT_TERMINAL',
        });
      t.status = 'queued';
      t.attempts = [];
      delete t.nextAttemptAt;
    });
    this.schedule(profile, task, 0);
    return task;
  }
  async cancel(profile: string, id: string) {
    return this.change(profile, id, (t) => {
      if (!terminal.includes(t.status)) t.status = 'cancelled';
    });
  }
  async onPluginUninstalled(pluginId: string) {
    for (const profile of await this.profiles()) {
      for (const task of await this.store.list(profile)) {
        if (
          task.explorer.verifierPluginId === pluginId &&
          !terminal.includes(task.status)
        )
          await this.change(profile, task.id, (t) => {
            t.status = 'cancelled';
            t.detail = 'plugin-removed';
          });
      }
    }
  }
  async recoverStartup() {
    for (const profile of await this.profiles())
      for (const task of await this.store.list(profile))
        if (!terminal.includes(task.status))
          this.schedule(
            profile,
            task,
            task.nextAttemptAt
              ? Math.max(0, Date.parse(task.nextAttemptAt) - Date.now())
              : 0
          );
  }
  async reconcile() {
    /* Task 6 supplies run scans; retained as an explicit startup seam. */
  }
  private schedule(profile: string, task: VerificationTask, delay: number) {
    const key = `${profile}:${task.id}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => void this.process(profile, task.id), delay)
    );
  }
  private async process(profile: string, id: string) {
    const task = (await this.store.list(profile)).find((t) => t.id === id);
    if (!task || terminal.includes(task.status)) return;
    const polling =
      task.status === 'polling' && task.attempts.at(-1)?.pollTicket;
    const attempt = await this.change(profile, id, (t) => {
      t.attempts.push({
        startedAt: new Date().toISOString(),
        outcome: polling ? 'poll' : 'submit',
        ...(polling ? { pollTicket: polling } : {}),
      });
      t.status = polling ? 'polling' : 'submitting';
    });
    const result = await this.executor.execute(
      task.explorer.verifierPluginId,
      polling ? 'checkVerification' : 'verify',
      polling
        ? {
            pollTicket: polling,
            chainId: task.chainId,
            address: task.address,
            explorerUrl: task.explorer.url,
            apiUrl: task.explorer.apiUrl,
          }
        : {
            chainId: task.chainId,
            address: task.address,
            explorerUrl: task.explorer.url,
            apiUrl: task.explorer.apiUrl,
            encodedConstructorArgs: task.encodedConstructorArgs,
            creationTxHash: task.creationTxHash,
          },
      { chainScope: task.chainId }
    );
    if (!result.success)
      return void this.failOrRetry(profile, attempt, undefined, true);
    const data = result.data as any;
    const detail = sanitizePluginString(data.detail, 500);
    const ticket = sanitizePluginString(data.pollTicket, 512);
    if (data.status === 'verified' || data.status === 'already-verified')
      return void this.change(profile, id, (t) => {
        t.status = data.status;
        t.detail = detail;
      });
    if (data.status === 'pending' && ticket) {
      const next = await this.change(profile, id, (t) => {
        t.status = 'polling';
        t.detail = detail;
        t.attempts.at(-1)!.pollTicket = ticket;
      });
      return void this.schedule(profile, next, 10_000);
    }
    return void this.failOrRetry(
      profile,
      attempt,
      detail,
      data.retryable !== false
    );
  }
  private async failOrRetry(
    profile: string,
    task: VerificationTask,
    detail?: string,
    retryable = true
  ) {
    const submits = task.attempts.filter((a) => a.outcome === 'submit').length;
    if (!retryable || submits >= MAX_SUBMIT_ATTEMPTS)
      return void this.change(profile, task.id, (t) => {
        t.status = 'failed';
        t.detail = detail;
      });
    const wait =
      SUBMIT_BACKOFF_MS[Math.min(submits, SUBMIT_BACKOFF_MS.length - 1)];
    const next = await this.change(profile, task.id, (t) => {
      t.status = 'queued';
      t.detail = detail;
      t.nextAttemptAt = new Date(Date.now() + wait).toISOString();
    });
    this.schedule(profile, next, wait);
  }
  private async change(
    profile: string,
    id: string,
    fn: (task: VerificationTask) => void
  ) {
    const task = await this.store.mutate(profile, id, fn);
    this.events.emit(profile, task);
    return task;
  }
  private async profiles() {
    return [] as string[];
  }
}
