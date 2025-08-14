// Minimal Redux store configuration
// - Adds only RTK Query reducer + middleware
import { configureStore } from '@reduxjs/toolkit';
import { igniteApi } from './services/igniteApi';
import { appReducer } from './features/app/appSlice';
import { connectionReducer } from './features/connection/connectionSlice';
import { websocketMiddleware } from './features/connection/websocketMiddleware';
import { toastListener } from './middleware/toastListener';
import {
  profilesReducer,
  profilesApi,
} from './features/profiles/profilesSlice';
import { apiGate } from './middleware/apiGate';
import { uiEffects } from './middleware/uiEffects';

export const store = configureStore({
  reducer: {
    // Local UI theme state
    app: appReducer,
    connection: connectionReducer,
    profiles: profilesReducer,
    // Mount the RTK Query reducer at the path it expects
    [igniteApi.reducerPath]: igniteApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    // Add RTK Query middleware for caching, polling, and automatic refetching
    getDefaultMiddleware({ serializableCheck: false })
      .prepend(
        apiGate.middleware,
        uiEffects.middleware,
        toastListener.middleware
      )
      .concat(igniteApi.middleware, websocketMiddleware),
});

// Helpful types for typed hooks
export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;

// Bootstrap: kick off connection and initial profile fetch
store.dispatch({ type: 'connection/startConnect' });
store.dispatch(profilesApi.fetchProfiles());
