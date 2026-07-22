import { useMemo } from 'react';
import type { WorkflowDocument } from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';
import {
  InstallFromGitModal,
  InstallFromPathModal,
  type ManageTarget,
} from '../../routes/settings/tabs/plugins/InstallPluginModal';

type RequiredPlugin = WorkflowDocument['requiredPlugins'][number];

interface InstallPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requiredPlugin?: RequiredPlugin;
  manage?: ManageTarget | null;
  prefillUrl?: string;
}

/**
 * The single entry point for third-party plugin installation. Workflow
 * documents may prefill it, but never get to dispatch an install themselves.
 */
export default function InstallPluginDialog({
  open,
  onOpenChange,
  requiredPlugin,
  manage,
  prefillUrl: requestedPrefillUrl,
}: InstallPluginDialogProps) {
  const source = requiredPlugin?.source;
  const prefillUrl = useMemo(
    () => (source?.kind === 'git' ? source.url : requestedPrefillUrl),
    [source, requestedPrefillUrl]
  );

  if (source?.kind === 'local') {
    return (
      <InstallFromPathModal
        open={open}
        onOpenChange={onOpenChange}
        prefillPath={source.contextDir}
        prefillDockerfile={source.dockerfile}
        manage={manage}
        requiredPlugin={{
          id: sanitizeDisplayText(requiredPlugin!.id),
          version: sanitizeDisplayText(requiredPlugin!.version),
          source: sanitizeDisplayText(
            source.dockerfile
              ? `${source.contextDir} (${source.dockerfile})`
              : source.contextDir
          ),
        }}
      />
    );
  }

  return (
    <InstallFromGitModal
      open={open}
      onOpenChange={onOpenChange}
      prefillUrl={prefillUrl}
      prefillSource={source?.kind === 'git' ? source : undefined}
      manage={manage}
      requiredPlugin={
        requiredPlugin
          ? {
              id: sanitizeDisplayText(requiredPlugin.id),
              version: sanitizeDisplayText(requiredPlugin.version),
              source: source ? sanitizeDisplayText(source.url) : undefined,
            }
          : undefined
      }
    />
  );
}
