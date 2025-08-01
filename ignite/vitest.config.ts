import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testMatch: ['**/__tests__/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/__tests__/**'],
    },
  },
});
