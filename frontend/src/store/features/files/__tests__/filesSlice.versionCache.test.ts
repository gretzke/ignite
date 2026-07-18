// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { isApiDispatchAction } from '../../../api/client';
import { filesApi, filesReducer } from '../filesSlice';

const artifactData = (bytecodeHash: string) => ({
  solidityVersion: '0.8.30',
  optimizer: true,
  optimizerRuns: 200,
  viaIR: false,
  bytecodeHash,
  abi: [],
  creationCode: '0x',
  deployedBytecode: '0x',
});

describe('version-scoped file cache', () => {
  it('keeps file content and artifact data separate for two commits of the same path', () => {
    const repoPath = 'https://example.test/contracts.git';
    const filePath = 'src/Counter.sol';
    const artifactPath = 'out/Counter.sol/Counter.json';
    const pins = [
      { url: repoPath, commit: 'a'.repeat(40) },
      { url: repoPath, commit: 'b'.repeat(40) },
    ];
    let state = filesReducer(undefined, { type: '@@init' });

    pins.forEach((pin, index) => {
      const [loading, request] = filesApi.fetchFileContent(repoPath, filePath, pin);
      state = filesReducer(state, loading);
      expect(isApiDispatchAction(request)).toBe(true);
      if (!isApiDispatchAction(request)) return;
      const contentAction = request.payload.onSuccess?.({ content: `version-${index + 1}` });
      expect(contentAction).toBeDefined();
      state = filesReducer(state, contentAction as never);

      const artifactRequest = filesApi.fetchArtifactData(repoPath, artifactPath, 'foundry', filePath, pin);
      expect(isApiDispatchAction(artifactRequest)).toBe(true);
      if (!isApiDispatchAction(artifactRequest)) return;
      const artifactAction = artifactRequest.payload.onSuccess?.(artifactData(`hash-${index + 1}`));
      expect(artifactAction).toBeDefined();
      state = filesReducer(state, artifactAction as never);
    });

    const firstKey = `${repoPath}\u0000${pins[0].commit.slice(0, 12)}:${filePath}`;
    const secondKey = `${repoPath}\u0000${pins[1].commit.slice(0, 12)}:${filePath}`;
    expect(firstKey).not.toBe(secondKey);
    expect(state.files[firstKey].content?.content).toBe('version-1');
    expect(state.files[secondKey].content?.content).toBe('version-2');
    expect(state.files[firstKey].artifactData?.[`foundry:${artifactPath}`].bytecodeHash).toBe('hash-1');
    expect(state.files[secondKey].artifactData?.[`foundry:${artifactPath}`].bytecodeHash).toBe('hash-2');
  });
});
