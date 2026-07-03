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
    // The Docker-backed *.integration.test.ts suites each spin up their own
    // ephemeral docker networks/containers (egress proxy, buildkitd, repo
    // containers). Vitest runs test FILES in parallel by default, so with
    // all 4 integration suites left in the default project they contend for
    // the same Docker daemon at once — under that load, one suite's freshly
    // created --internal network can have its egress-proxy container come up
    // too slowly relative to the others' concurrent network/container churn,
    // and the isolated build fails to reach the proxy with ECONNREFUSED
    // (see isolated-build.integration.test.ts flaking only in the full run,
    // never in isolation). Splitting them into their own project with
    // fileParallelism disabled runs them one at a time while unit tests keep
    // running in parallel in the default project.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/__tests__/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
