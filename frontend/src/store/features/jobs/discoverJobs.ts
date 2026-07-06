import type { UnknownAction } from '@reduxjs/toolkit';
import { apiClient } from '../../api/client';
import { jobsLoaded } from './jobsSlice';
import { wsSend } from '../../middleware/websocket';

// Server-initiated jobs (e.g. the repo re-detection sweep that runs after a
// plugin install/update/uninstall) are invisible to the client until it asks:
// list the active jobs and subscribe to them, so their terminal snapshots
// route through jobsEffects and update repo state live. Same pattern as the
// WS reconnect recovery.
export function discoverActiveJobs() {
  return apiClient.dispatch.listJobs({
    query: { active: 'true' },
    onSuccess: (data) => {
      const actions: UnknownAction[] = [jobsLoaded(data.jobs)];
      for (const job of data.jobs) {
        const lastSeq = job.events.reduce(
          (max, event) => Math.max(max, event.seq),
          0
        );
        actions.push(
          wsSend({ type: 'subscribe', jobId: job.id, afterSeq: lastSeq })
        );
      }
      return actions;
    },
    onError: () => [],
  });
}
