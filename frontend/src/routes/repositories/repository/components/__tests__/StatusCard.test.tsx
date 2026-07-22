// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusCard from '../StatusCard';

describe('StatusCard lifecycle failures', () => {
  it('shows Compiling when an active compile overlaps a durable lifecycle error', () => {
    const store = configureStore({ reducer: () => ({}) });

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <StatusCard
          repoPath="/workspace/contracts"
          frameworks={[{ id: 'foundry', name: 'Foundry' }]}
          compilations={{ foundry: { status: 'waiting' } }}
          lifecycleError={{
            code: 'COMPILE_FAILED',
            message: 'previous compile failed',
            at: '2026-07-22T00:00:00.000Z',
          }}
        />
      </Provider>
    );

    expect(html).toContain('Compiling contracts...');
    expect(html).not.toContain('Compilation failed');
  });
});
