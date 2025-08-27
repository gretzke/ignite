// Minimal Redux store configuration
// - Adds only RTK Query reducer + middleware
import { configureStore } from '@reduxjs/toolkit';
import { appReducer } from './features/app/appSlice';
import { connectionReducer } from './features/connection/connectionSlice';
import { websocketMiddleware } from './middleware/websocket';
import { toastListener } from './middleware/toastListener';
import {
  profilesReducer,
  profilesApi,
} from './features/profiles/profilesSlice';
import { repositoriesReducer } from './features/repositories/repositoriesSlice';
import { compilerReducer } from './features/compiler/compilerSlice';
import { apiGate } from './middleware/apiGate';
import { uiEffects } from './middleware/uiEffects';
import { repositoriesEffects } from './middleware/repositoriesEffects';
import { compilerEffects } from './middleware/compilerEffects';

export const store = configureStore({
  reducer: {
    // Local UI theme state
    app: appReducer,
    connection: connectionReducer,
    profiles: profilesReducer,
    repositories: repositoriesReducer,
    compiler: compilerReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({ serializableCheck: false })
      .prepend(
        apiGate.middleware,
        uiEffects.middleware,
        toastListener.middleware,
        repositoriesEffects.middleware,
        compilerEffects.middleware
      )
      .concat(websocketMiddleware),
});

// Helpful types for typed hooks
export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;

// Bootstrap: kick off connection and initial profile fetch
store.dispatch({ type: 'connection/startConnect' });
store.dispatch(profilesApi.fetchProfiles());
