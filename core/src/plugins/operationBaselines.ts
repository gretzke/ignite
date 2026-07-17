import {
  PluginType,
  type PluginMetadata,
  type PluginPermissionId,
} from '@ignite/plugin-types/types';

// These values intentionally do not derive from plugin base classes: they are
// the compatibility contract for manifests written before `operations`.
export const BASELINE_OPERATIONS: Readonly<
  Record<PluginType, readonly string[]>
> = {
  [PluginType.COMPILER]: [
    'detect',
    'install',
    'compile',
    'listArtifacts',
    'getArtifactData',
    'getVerificationBundle',
    'getWatchPaths',
  ],
  [PluginType.RPC_PROVIDER]: ['getSupportedChains'],
  [PluginType.SIGNER_PROVIDER]: [
    'getAccounts',
    'signTransaction',
    'sendTransaction',
  ],
  [PluginType.VERIFIER]: [
    'getSupportedExplorers',
    'verify',
    'checkVerification',
    'getCreationTx',
  ],
  [PluginType.DEPLOYMENT_TYPE]: [
    'describeDeploymentType',
    'prepareDeployment',
    'validateDeployment',
  ],
  [PluginType.DEPLOYMENT_HOOK]: [
    'describeDeploymentHook',
    'onRunCompleted',
    'suggestAddresses',
  ],
  [PluginType.CONTRACT_TYPE]: [
    'describeContractType',
    'getContractArtifact',
  ],
};

export const HOST_PERMISSION_MINIMUMS: Readonly<
  Record<string, PluginPermissionId>
> = {
  install: 'repoWrite',
  compile: 'repoWrite',
  verify: 'net',
  getSupportedExplorers: 'net',
  checkVerification: 'net',
  getCreationTx: 'net',
  sendTransaction: 'net',
};

export function effectiveOperations(metadata: PluginMetadata): string[] {
  if (metadata.operations !== undefined) return [...metadata.operations];
  const operations: string[] = [];
  for (const type of metadata.types) {
    for (const operation of BASELINE_OPERATIONS[type] ?? []) {
      if (!operations.includes(operation)) operations.push(operation);
    }
  }
  return operations;
}

// Permission dimensions are independent. Preserve manifest-hint ordering so
// the executor can surface the first unmet declared requirement consistently.
export function requiredPermissions(
  metadata: PluginMetadata,
  operation: string,
): PluginPermissionId[] {
  const permissions: PluginPermissionId[] = [];
  const hint = metadata.operationPermissions?.[operation];
  const minimum = HOST_PERMISSION_MINIMUMS[operation];
  if (hint) permissions.push(hint);
  if (minimum && !permissions.includes(minimum)) permissions.push(minimum);
  return permissions;
}

export function effectiveRepoRead(metadata: PluginMetadata): boolean {
  return metadata.repoRead ?? metadata.types.includes(PluginType.COMPILER);
}
