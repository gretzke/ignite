import { createListenerMiddleware } from '@reduxjs/toolkit';
import { setRepositoryFrameworks } from '../features/repositories/repositoriesSlice';
import {
  setCompilationStatus,
  installDependencies,
  compileProject,
} from '../features/compiler/compilerSlice';
import type { AppDispatch } from '../store';

// Create a listener middleware for compiler effects
export const compilerEffects = createListenerMiddleware();

// Listen for successful framework detection and auto-trigger install/compile
compilerEffects.startListening({
  actionCreator: setRepositoryFrameworks,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { pathOrUrl, frameworks } = action.payload;

    // Only proceed if frameworks were actually detected
    if (!frameworks || frameworks.length === 0) {
      return;
    }

    // Start install/compile process for each detected framework
    for (const framework of frameworks) {
      const { id: pluginId } = framework;

      // Set initial status to installing
      dispatch(
        setCompilationStatus({
          repoPath: pathOrUrl,
          frameworkId: pluginId,
          status: 'installing',
        })
      );

      // Start installation
      const installAction = installDependencies({ pathOrUrl, pluginId });
      dispatch(installAction);

      // Note: The compile action will be triggered by the install success callback
      // in the compiler slice, which sets status to 'compiling' and then calls compile
    }
  },
});

// Listen for compilation status changes and auto-trigger compile after install
compilerEffects.startListening({
  actionCreator: setCompilationStatus,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { repoPath, frameworkId, status } = action.payload;

    // If status changed to 'compiling', trigger the compile operation
    if (status === 'compiling') {
      const compileAction = compileProject({
        pathOrUrl: repoPath,
        pluginId: frameworkId,
      });
      dispatch(compileAction);
    }
  },
});
