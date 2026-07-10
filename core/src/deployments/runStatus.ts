import type { RunRecord, RunStatus } from '@ignite/api';

export function runStatus(
  run: Pick<RunRecord, 'lanes' | 'abortRequested'>
): RunStatus {
  const lanes = Object.values(run.lanes);
  const terminal = lanes.every(
    (lane) => lane.status === 'completed' || lane.status === 'aborted'
  );
  const abortedAfterFailure = lanes.some(
    (lane) =>
      lane.status === 'aborted' &&
      lane.steps.some((step) => {
        const last = step.attempts.at(-1);
        return Boolean(
          last?.error &&
            (last.resolution === 'abort-lane' ||
              last.resolution === 'abort-run')
        );
      })
  );
  if (run.abortRequested && terminal) return 'aborted';
  if (lanes.length > 0 && lanes.every((lane) => lane.status === 'completed'))
    return 'completed';
  if (terminal && abortedAfterFailure) return 'failed';
  if (lanes.some((lane) => lane.status === 'paused')) return 'paused';
  return 'running';
}
