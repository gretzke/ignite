// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { ConnectionStatus, setStatus } from '../../features/connection/connectionSlice';
import { verificationsReducer } from '../../features/verifications/verificationsSlice';
import { verificationsEffects } from '../verificationsEffects';

describe('verificationsEffects', () => {
  it('resubscribes with the durable epoch cursor on reconnect', async () => {
    const sent: unknown[] = [];
    const recorder = () => (next: (action: unknown) => unknown) => (action: unknown) => {
      if (
        typeof action === 'object' &&
        action !== null &&
        'type' in action &&
        action.type === 'ws/send'
      ) {
        sent.push((action as unknown as { payload: unknown }).payload);
      }
      return next(action);
    };
    const store = configureStore({
      reducer: {
        verifications: verificationsReducer,
        // The effect only examines verifications; a small reducer keeps this
        // test independent from the application store bootstrap.
        connection: (state = {}) => state,
      },
      preloadedState: {
        verifications: {
          tasks: {},
          byRun: {},
          manualIds: undefined,
          epoch: 'epoch-1',
          seq: 42,
        },
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().prepend(verificationsEffects.middleware, recorder),
    });

    store.dispatch(setStatus(ConnectionStatus.CONNECTED));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toContainEqual({
      type: 'subscribe-verifications',
      epoch: 'epoch-1',
      afterSeq: 42,
    });
  });
});
