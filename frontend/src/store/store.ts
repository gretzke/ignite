// Minimal Redux store configuration
// - Adds only RTK Query reducer + middleware
import { configureStore } from '@reduxjs/toolkit';
import { igniteApi } from './services/igniteApi';
import { appReducer } from './features/app/appSlice';
import { connectionReducer } from './features/connection/connectionSlice';
import { websocketMiddleware } from './features/connection/websocketMiddleware';

export const store = configureStore({
  reducer: {
    // Local UI theme state
    app: appReducer,
    connection: connectionReducer,
    // Mount the RTK Query reducer at the path it expects
    [igniteApi.reducerPath]: igniteApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    // Add RTK Query middleware for caching, polling, and automatic refetching
    getDefaultMiddleware().concat(igniteApi.middleware, websocketMiddleware),
});

// Helpful types for typed hooks
export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;
