import type { VerificationEvent, VerificationTask } from '@ignite/api';
export type VerificationListener = (
  profileId: string,
  event: VerificationEvent
) => void;
export class VerificationEvents {
  readonly epoch: string;
  private listeners = new Set<VerificationListener>();
  private seq = new Map<string, number>();
  private history = new Map<string, VerificationEvent[]>();
  constructor(epoch = crypto.randomUUID()) {
    this.epoch = epoch;
  }
  subscribe(listener: VerificationListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cursor(profileId: string) {
    return { epoch: this.epoch, lastSeq: this.seq.get(profileId) ?? 0 };
  }
  eventsSince(profileId: string, epoch: string, afterSeq: number) {
    return epoch === this.epoch
      ? (this.history.get(profileId) ?? []).filter((e) => e.seq > afterSeq)
      : [];
  }
  emit(profileId: string, task: VerificationTask) {
    const event = {
      epoch: this.epoch,
      seq: (this.seq.get(profileId) ?? 0) + 1,
      ts: Date.now(),
      task: structuredClone(task),
    };
    this.seq.set(profileId, event.seq);
    const history = this.history.get(profileId) ?? [];
    history.push(event);
    if (history.length > 1000) history.shift();
    this.history.set(profileId, history);
    for (const listener of this.listeners) listener(profileId, event);
  }
}
