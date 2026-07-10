import { createListenerMiddleware } from '@reduxjs/toolkit';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { Lane, RunRecord } from '@ignite/api';
import { apiClient } from '../api/client';
import {
  runEventReceived,
  backgroundRunFinished,
  backgroundRunsReceived,
  runsListReceived,
  subscribeRunRequested,
  unsubscribeRunRequested,
} from '../features/deployments/deploymentsSlice';
import {
  ConnectionStatus,
  setStatus,
} from '../features/connection/connectionSlice';
import { triggerToast } from './toastListener';
import { wsSend } from './websocket';
import type { AppDispatch, RootState } from '../store';

export const deploymentsEffects = createListenerMiddleware();

function subscribeFrame(state: RootState, runId: string) {
  const cursor = state.deployments.epochByRun[runId];
  return wsSend({
    type: 'subscribe-run',
    runId,
    ...(cursor ? { epoch: cursor.epoch, afterSeq: cursor.lastSeq } : {}),
  });
}

deploymentsEffects.startListening({
  actionCreator: subscribeRunRequested,
  effect: async (action, listenerApi) => {
    const state = listenerApi.getState() as RootState;
    if (state.deployments.backgroundSubscriptions[action.payload]) return;
    listenerApi.dispatch(
      subscribeFrame(listenerApi.getState() as RootState, action.payload)
    );
  },
});

deploymentsEffects.startListening({
  actionCreator: unsubscribeRunRequested,
  effect: async (action, listenerApi) => {
    const state = listenerApi.getState() as RootState;
    if (state.deployments.backgroundSubscriptions[action.payload]) return;
    listenerApi.dispatch(
      wsSend({ type: 'unsubscribe-run', runId: action.payload })
    );
  },
});

// On every successful connection, discover active runs and subscribe to the
// union of server-active runs and explicit run-view subscriptions. The REST
// snapshot also keeps the deployments list fresh after time offline.
deploymentsEffects.startListening({
  actionCreator: setStatus,
  effect: async (action, listenerApi) => {
    if (action.payload !== ConnectionStatus.CONNECTED) return;
    const dispatch = listenerApi.dispatch as AppDispatch;
    dispatch(
      apiClient.dispatch.listDeploymentRuns({
        query: { active: 'true' },
        onSuccess: (data) => {
          const current = listenerApi.getState() as RootState;
          const viewRunIds = Object.keys(
            current.deployments.activeSubscriptions
          );
          const backgroundRunIds = data.runs.map(({ id }) => id);
          const runIds = new Set([...viewRunIds, ...backgroundRunIds]);
          const actions: UnknownAction[] = [
            runsListReceived(data),
            backgroundRunsReceived(backgroundRunIds),
          ];
          for (const runId of runIds) {
            actions.push(subscribeFrame(current, runId));
          }
          return actions;
        },
      })
    );
  },
});

function previousLane(
  state: RootState,
  runId: string,
  chainId: number
): Lane | undefined {
  return state.deployments.runsById[runId]?.lanes[String(chainId)];
}

deploymentsEffects.startListening({
  actionCreator: runEventReceived,
  effect: async (action, listenerApi) => {
    const { runId, event } = action.payload;
    const before = listenerApi.getOriginalState() as RootState;
    const after = listenerApi.getState() as RootState;
    const run = after.deployments.runsById[runId] as RunRecord | undefined;
    if (!run) return;

    if (event.kind === 'lane' && event.lane?.status === 'paused') {
      const chainId = event.chainId ?? event.lane.chainId;
      if (previousLane(before, runId, chainId)?.status === 'paused') return;
      listenerApi.dispatch(
        triggerToast({
          title: `Run paused on chain ${chainId}`,
          description: event.lane.pause?.error ?? run.name,
          variant: 'warning',
          duration: 8000,
        })
      );
      return;
    }

    if (
      before.deployments.runsById[runId]?.status !== 'completed' &&
      run.status === 'completed'
    ) {
      listenerApi.dispatch(
        triggerToast({
          title: 'Run completed',
          description: run.name,
          variant: 'success',
          duration: 5000,
        })
      );
    }

    if (
      ['completed', 'failed', 'aborted'].includes(run.status) &&
      before.deployments.runsById[runId]?.status !== run.status
    ) {
      listenerApi.dispatch(backgroundRunFinished(runId));
      listenerApi.dispatch(wsSend({ type: 'unsubscribe-run', runId }));
    }
  },
});
