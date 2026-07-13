export type PointerPauseEditTarget =
  | { section: 'args'; field?: string }
  | { section: 'target' }
  | { section: 'libraries'; key: string }
  | undefined;

/** The API has historically sent pause contexts without details, so validate
 * the small pointer payload at the boundary instead of trusting an untyped
 * run snapshot. */
export function pointerPauseEditTarget(
  details: unknown,
  stepId: string | undefined
): PointerPauseEditTarget {
  if (!details || typeof details !== 'object') return undefined;
  const candidate = details as { stepId?: unknown; path?: unknown };
  if (
    candidate.stepId !== stepId ||
    typeof candidate.path !== 'string'
  )
    return undefined;
  const { path } = candidate;
  if (path === 'target') return { section: 'target' };
  const arg = /^args\.([^.[\]]+)$/.exec(path);
  if (arg) return { section: 'args', field: arg[1] };
  // Nested tuple members and array indices must be edited in the argument
  // editor, but never become a fabricated literal object key.
  if (path.startsWith('args.')) return { section: 'args' };
  // Link-reference keys include Solidity filenames (and therefore dots), so
  // unlike argument members everything after `libraries.` is the one key.
  const library = /^libraries\.(.+)$/.exec(path);
  if (library) return { section: 'libraries', key: library[1] };
  return undefined;
}
