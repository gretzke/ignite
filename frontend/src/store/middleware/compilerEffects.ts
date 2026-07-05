import { createListenerMiddleware } from '@reduxjs/toolkit';
import { setRepositoryFrameworks } from '../features/repositories/repositoriesSlice';
import {
  setCompilationStatus,
  compileProject,
  listArtifacts,
} from '../features/compiler/compilerSlice';
import type { AppDispatch } from '../store';

// Create a listener middleware for compiler effects
//
// Both actions below are now dispatched by jobsEffects once the
// corresponding job (compiler.detect / compiler.install / compiler.compile)
// reaches a terminal state, not directly from an HTTP onSuccess — but the
// action shapes are unchanged, so this file still owns "what happens next"
// for the compile chain (detect -> load artifacts; install -> compile ->
// reload artifacts).
export const compilerEffects = createListenerMiddleware();

// On framework detection, load any artifacts from a previous compile but do
// NOT auto-compile — installing and compiling every repo on startup is slow
// and usually unnecessary. Compilation is user-triggered via "Clean compile".
compilerEffects.startListening({
  actionCreator: setRepositoryFrameworks,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { pathOrUrl, frameworks } = action.payload;

    if (!frameworks || frameworks.length === 0) {
      return;
    }

    for (const framework of frameworks) {
      const { id: pluginId } = framework;

      dispatch(
        setCompilationStatus({
          repoPath: pathOrUrl,
          frameworkId: pluginId,
          status: 'idle',
        })
      );

      dispatch(listArtifacts({ pathOrUrl, pluginId }));
    }
  },
});

// Drive the install -> compile -> refresh-artifacts chain off status changes
compilerEffects.startListening({
  actionCreator: setCompilationStatus,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { repoPath, frameworkId, status } = action.payload;

    // Install finished -> run the compile operation
    if (status === 'compiling') {
      dispatch(compileProject({ pathOrUrl: repoPath, pluginId: frameworkId }));
    }

    // Compile finished -> reload the artifact list
    if (status === 'ready') {
      dispatch(listArtifacts({ pathOrUrl: repoPath, pluginId: frameworkId }));
    }
  },
});
