// Minimal Redux store configuration
// - Adds only RTK Query reducer + middleware
import { configureStore } from '@reduxjs/toolkit';
import { appReducer } from './features/app/appSlice';
import { chainsReducer } from './features/chains/chainsSlice';
import { connectionReducer } from './features/connection/connectionSlice';
import { websocketMiddleware } from './middleware/websocket';
import { toastListener } from './middleware/toastListener';
import {
  profilesReducer,
  profilesApi,
} from './features/profiles/profilesSlice';
import { repositoriesReducer } from './features/repositories/repositoriesSlice';
import { compilerReducer } from './features/compiler/compilerSlice';
import { filesReducer } from './features/files/filesSlice';
import { trustReducer } from './features/plugins/trustSlice';
import { pluginsReducer } from './features/plugins/pluginsSlice';
import { jobsReducer } from './features/jobs/jobsSlice';
import { signersReducer } from './features/signers/signersSlice';
import { deployDraftReducer } from './features/deployments/deployDraftSlice';
import { deploymentsReducer } from './features/deployments/deploymentsSlice';
import { apiGate } from './middleware/apiGate';
import { uiEffects } from './middleware/uiEffects';
import { repositoriesEffects } from './middleware/repositoriesEffects';
import { compilerEffects } from './middleware/compilerEffects';
import { jobsEffects } from './middleware/jobsEffects';
import { deploymentsEffects } from './middleware/deploymentsEffects';
import { explorersReducer } from './features/explorers/explorersSlice';
import { verificationsReducer } from './features/verifications/verificationsSlice';
import { workflowsReducer } from './features/workflows/workflowsSlice';
import { verificationsEffects } from './middleware/verificationsEffects';
import {
  loadDraft,
  saveDraft,
} from './features/deployments/deployDraftPersistence';

const persistedDraft = loadDraft();

export const store = configureStore({
  reducer: {
    // Local UI theme state
    app: appReducer,
    chains: chainsReducer,
    connection: connectionReducer,
    profiles: profilesReducer,
    repositories: repositoriesReducer,
    compiler: compilerReducer,
    files: filesReducer,
    trust: trustReducer,
    plugins: pluginsReducer,
    jobs: jobsReducer,
    signers: signersReducer,
    deployDraft: deployDraftReducer,
    deployments: deploymentsReducer,
    explorers: explorersReducer,
    verifications: verificationsReducer,
    workflows: workflowsReducer,
  },
  preloadedState: persistedDraft ? { deployDraft: persistedDraft } : undefined,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({ serializableCheck: false })
      .prepend(
        apiGate.middleware,
        uiEffects.middleware,
        toastListener.middleware,
        repositoriesEffects.middleware,
        compilerEffects.middleware,
        jobsEffects.middleware,
        deploymentsEffects.middleware,
        verificationsEffects.middleware
      )
      .concat(websocketMiddleware),
});

// Helpful types for typed hooks
export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;

// Persist the deploy draft synchronously on every change so an accidental
// refresh cannot lose a half-built cross-repo deployment.
let lastPersistedDraft = store.getState().deployDraft;
store.subscribe(() => {
  const draft = store.getState().deployDraft;
  if (draft === lastPersistedDraft) return;
  lastPersistedDraft = draft;
  saveDraft(draft);
});

// Bootstrap: kick off connection and initial profile fetch
store.dispatch({ type: 'connection/startConnect' });
store.dispatch(profilesApi.fetchProfiles());
