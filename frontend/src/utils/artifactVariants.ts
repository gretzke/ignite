import type { ArtifactLocation } from '@ignite/api';

export type ArtifactVariantGroup = {
  sourcePath: string;
  contractName: string;
  artifacts: ArtifactLocation[];
};

export function artifactVariantLabel(artifact: ArtifactLocation): string {
  const parts = [artifact.variant?.profile, artifact.variant?.solcVersion].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length ? parts.join(' · ') : 'default';
}

export function groupArtifactVariants(
  artifacts: ArtifactLocation[]
): ArtifactVariantGroup[] {
  const groups = new Map<string, ArtifactVariantGroup>();
  for (const artifact of artifacts) {
    const key = `${artifact.sourcePath}\u0000${artifact.contractName}`;
    const group = groups.get(key) ?? {
      sourcePath: artifact.sourcePath,
      contractName: artifact.contractName,
      artifacts: [],
    };
    if (!groups.has(key)) groups.set(key, group);
    if (!group.artifacts.some((item) => item.artifactPath === artifact.artifactPath))
      group.artifacts.push(artifact);
  }
  return [...groups.values()].sort((a, b) =>
    `${a.sourcePath}:${a.contractName}`.localeCompare(
      `${b.sourcePath}:${b.contractName}`
    )
  );
}

export function requiresExplicitVariantPick(
  group: Pick<ArtifactVariantGroup, 'artifacts'>
): boolean {
  return group.artifacts.length > 1;
}

export function artifactVariantFromPath(
  artifactPath: string,
  contractName: string
): string | undefined {
  const filename = artifactPath.split('/').pop() ?? '';
  const match = filename.match(new RegExp(`^${escapeRegExp(contractName)}\\.((?:(?:\\d+\\.\\d+\\.\\d+)(?:\\.[^.]+)?|[^.]+))\\.json$`));
  return match?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
