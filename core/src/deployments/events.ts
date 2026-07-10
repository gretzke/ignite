import type { RunEvent, RunRecord } from '@ignite/api';

export type RunListener = (runId: string, event: RunEvent) => void;

export class RunEvents {
  readonly epoch: string;
  private readonly listeners = new Set<RunListener>();
  private readonly sequence = new Map<string, number>();
  private readonly history = new Map<string, RunEvent[]>();

  constructor(epoch = crypto.randomUUID()) {
    this.epoch = epoch;
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsSince(runId: string, epoch: string, afterSeq: number): RunEvent[] {
    if (epoch !== this.epoch) return [];
    return (this.history.get(runId) ?? []).filter(
      (event) => event.seq > afterSeq
    );
  }

  cursor(runId: string): { epoch: string; lastSeq: number } {
    return { epoch: this.epoch, lastSeq: this.sequence.get(runId) ?? 0 };
  }

  emitLane(run: RunRecord, chainId: number, now: number): void {
    const lane = run.lanes[String(chainId)];
    if (!lane) return;
    this.emit(run.id, {
      epoch: this.epoch,
      seq: this.next(run.id),
      ts: now,
      kind: 'lane',
      chainId,
      lane: globalThis.structuredClone(lane),
    });
  }

  emitRun(run: RunRecord, now: number): void {
    this.emit(run.id, {
      epoch: this.epoch,
      seq: this.next(run.id),
      ts: now,
      kind: 'run',
      runPatch: {
        status: run.status,
        ...(run.abortRequested === undefined
          ? {}
          : { abortRequested: run.abortRequested }),
      },
    });
  }

  private next(runId: string): number {
    const value = (this.sequence.get(runId) ?? 0) + 1;
    this.sequence.set(runId, value);
    return value;
  }

  private emit(runId: string, event: RunEvent): void {
    const events = this.history.get(runId) ?? [];
    events.push(event);
    if (events.length > 1_000) events.shift();
    this.history.set(runId, events);
    for (const listener of this.listeners) listener(runId, event);
  }
}
