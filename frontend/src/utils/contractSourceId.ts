import type { RepoContractSource } from '@ignite/api';

// Deployment plans require globally unique contract ids, and drafts can now
// span repos. Each component is URI-encoded (':' becomes '%3A') so the joined
// id is unambiguous even though repo URLs contain the delimiter.
export function contractSourceId(source: Omit<RepoContractSource, 'id'>): string {
  const parts = [
    source.repoPathOrUrl,
    source.frameworkId,
    source.artifactPath,
    source.contractName,
  ];

  // Keep unpinned sources byte-for-byte compatible with the old identity.
  // A pin is a distinct source workspace, so its commit must participate in
  // the id or identical artifacts from two versions collapse in a draft.
  if (source.pin) parts.push(source.pin.commit.slice(0, 12));

  return parts
    .map(encodeURIComponent)
    .join(':');
}
