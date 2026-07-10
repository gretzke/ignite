// shared/api intentionally has no test-runner dependency. The monorepo test
// runner supplies Vitest at execution time; this declaration keeps package
// type-checking independent of that runner installation.
declare module "vitest" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export namespace it {
    function each<T>(
      cases: readonly T[],
    ): (name: string, fn: (value: T) => void | Promise<void>) => void;
  }
  export function expect(value: unknown): any;
}
