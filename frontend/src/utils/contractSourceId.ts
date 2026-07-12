import type { ContractSource } from '@ignite/api';

// Deployment plans require globally unique contract ids, and drafts can now
// span repos. Each component is URI-encoded (':' becomes '%3A') so the joined
// id is unambiguous even though repo URLs contain the delimiter.
export function contractSourceId(source: Omit<ContractSource, 'id'>): string {
  return [
    source.repoPathOrUrl,
    source.frameworkId,
    source.artifactPath,
    source.contractName,
  ]
    .map(encodeURIComponent)
    .join(':');
}
