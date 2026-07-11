import { createListenerMiddleware } from '@reduxjs/toolkit';
import type { RootState } from '../store';
import { ConnectionStatus, setStatus } from '../features/connection/connectionSlice';
import { verificationEventReceived } from '../features/verifications/verificationsSlice';
import { triggerToast } from './toastListener';
import { wsSend } from './websocket';

export const verificationsEffects = createListenerMiddleware();

function subscribeFrame(state: RootState) {
  return wsSend({
    type: 'subscribe-verifications',
    ...(state.verifications.epoch
      ? { epoch: state.verifications.epoch, afterSeq: state.verifications.seq }
      : {}),
  });
}

verificationsEffects.startListening({
  actionCreator: setStatus,
  effect: (action, listenerApi) => {
    if (action.payload !== ConnectionStatus.CONNECTED) return;
    listenerApi.dispatch(subscribeFrame(listenerApi.getState() as RootState));
  },
});

verificationsEffects.startListening({
  actionCreator: verificationEventReceived,
  effect: (action, listenerApi) => {
    const before = listenerApi.getOriginalState() as RootState;
    const previous = before.verifications.tasks[action.payload.task.id];
    if (action.payload.task.status !== 'failed' || previous?.status === 'failed')
      return;
    listenerApi.dispatch(
      triggerToast({
        title: 'Explorer verification failed',
        description: action.payload.task.explorer.label,
        variant: 'error',
        duration: 7000,
      })
    );
  },
});
