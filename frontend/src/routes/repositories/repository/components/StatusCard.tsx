import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle, Clock, AlertCircle, Loader2, Hammer } from 'lucide-react';
import { useAppDispatch } from '../../../../store/hooks';
import type { ContractSourcePin } from '@ignite/api';
import {
  cleanCompile,
  compileProject,
  type CompilationStatus,
} from '../../../../store/features/compiler/compilerSlice';
import type { IFramework } from '../../../../store/features/repositories/repositoriesSlice';

interface StatusCardProps {
  repoPath: string;
  frameworks: IFramework[];
  compilations: Record<string, { status: CompilationStatus; error?: string }>;
  pin?: ContractSourcePin;
}

export default function StatusCard({
  repoPath,
  frameworks,
  compilations,
  pin,
}: StatusCardProps) {
  const dispatch = useAppDispatch();
  // Compilation error shown in the details dialog; null = closed
  const [errorDetails, setErrorDetails] = useState<{
    frameworkName: string;
    error: string;
  } | null>(null);

  const handleCleanCompile = (frameworkId: string) => {
    if (pin) dispatch(compileProject({ pathOrUrl: repoPath, pluginId: frameworkId, pin }));
    else cleanCompile({ pathOrUrl: repoPath, pluginId: frameworkId }).forEach((action) => dispatch(action));
  };

  // Calculate overall status
  const getOverallStatus = (): {
    status:
      | 'ready'
      | 'installing'
      | 'compiling'
      | 'waiting'
      | 'error'
      | 'pending'
      | 'loading'
      | 'idle';
    message: string;
  } => {
    if (frameworks.length === 0) {
      return { status: 'pending', message: 'No frameworks detected' };
    }

    const statuses = frameworks.map((f) => compilations[f.id]?.status);

    // If any framework has an error
    if (statuses.some((s) => s === 'error')) {
      return { status: 'error', message: 'Compilation failed' };
    }

    // If any framework is still installing
    if (statuses.some((s) => s === 'installing')) {
      return { status: 'installing', message: 'Installing dependencies...' };
    }

    // If any framework is compiling
    if (statuses.some((s) => s === 'compiling')) {
      return { status: 'compiling', message: 'Compiling contracts...' };
    }

    if (statuses.some((s) => s === 'waiting')) {
      return { status: 'waiting', message: 'Compiling contracts...' };
    }

    // Artifact listing still in flight (or effects not run yet): we don't
    // know the build state, so don't claim "Not compiled".
    if (statuses.some((s) => s === 'loading' || s === undefined)) {
      return { status: 'loading', message: 'Checking build status...' };
    }

    // If all frameworks are ready
    if (statuses.every((s) => s === 'ready')) {
      return { status: 'ready', message: 'Ready for deployment' };
    }

    // Not compiled this session - waiting for the user to trigger a compile
    return {
      status: 'idle',
      message: 'Not compiled — run a clean compile when ready',
    };
  };

  const { status, message } = getOverallStatus();

  // Status icon and color
  const getStatusDisplay = (status: string) => {
    switch (status) {
      case 'ready':
        return {
          icon: <CheckCircle size={24} className="text-ok" />,
          color: 'text-ok',
          bgColor: 'bg-ok/10',
          borderColor: 'border-ok/20',
        };
      case 'installing':
        return {
          icon: <Loader2 size={24} className="text-info animate-spin" />,
          color: 'text-info',
          bgColor: 'bg-info/10',
          borderColor: 'border-info/20',
        };
      case 'compiling':
        return {
          icon: <Clock size={24} className="text-warn" />,
          color: 'text-warn',
          bgColor: 'bg-warn/10',
          borderColor: 'border-warn/20',
        };
      case 'waiting':
        return {
          icon: <Loader2 size={24} className="text-info animate-spin" />,
          color: 'text-info',
          bgColor: 'bg-info/10',
          borderColor: 'border-info/20',
        };
      case 'loading':
        return {
          icon: <Loader2 size={24} className="text-muted animate-spin" />,
          color: 'text-muted',
          bgColor: 'bg-muted/10',
          borderColor: 'border-muted/20',
        };
      case 'error':
        return {
          icon: <AlertCircle size={24} className="text-err" />,
          color: 'text-err',
          bgColor: 'bg-err/10',
          borderColor: 'border-err/20',
        };
      default:
        return {
          icon: <Clock size={24} className="text-muted" />,
          color: 'text-muted',
          bgColor: 'bg-muted/10',
          borderColor: 'border-muted/20',
        };
    }
  };

  const display = getStatusDisplay(status);

  return (
    <div className={`card-milky p-6 border ${display.borderColor}`}>
      <div className="flex items-center gap-4">
        {/* Status icon */}
        <div className={`p-3 rounded-full ${display.bgColor}`}>
          {display.icon}
        </div>

        {/* Status info */}
        <div className="flex-1">
          <h3 className="text-lg font-medium mb-1">Compilation Status</h3>
          <p className={`text-sm ${display.color} font-medium`}>{message}</p>
        </div>
      </div>

      {/* Framework details */}
      {frameworks.length > 0 && (
        <div className="mt-6 pt-6 border-t border-[var(--hairline)]">
          <div className="space-y-3">
            {frameworks.map((framework) => {
              const compilation = compilations[framework.id];
              const frameworkStatus = compilation?.status || 'idle';
              const frameworkDisplay = getStatusDisplay(frameworkStatus);
              const isBusy =
                frameworkStatus === 'installing' ||
                frameworkStatus === 'compiling';

              return (
                <div
                  key={framework.id}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        frameworkStatus === 'ready'
                          ? 'bg-ok'
                          : frameworkStatus === 'installing'
                            ? 'bg-info'
                            : frameworkStatus === 'compiling'
                              ? 'bg-warn'
                              : frameworkStatus === 'error'
                                ? 'bg-err'
                                : 'bg-muted'
                      }`}
                    />
                    <span className="text-sm font-medium">
                      {framework.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Per-framework status is redundant with the header
                        unless multiple frameworks can differ */}
                    {frameworks.length > 1 && (
                      <span className={`text-xs ${frameworkDisplay.color}`}>
                        {frameworkStatus === 'idle' && 'Not compiled'}
                        {frameworkStatus === 'installing' && 'Installing...'}
                        {frameworkStatus === 'compiling' && 'Compiling...'}
                        {frameworkStatus === 'ready' && 'Ready'}
                        {frameworkStatus === 'error' && 'Error'}
                      </span>
                    )}

                    {/* Show error details if available */}
                    {frameworkStatus === 'error' && compilation?.error && (
                      <button
                        type="button"
                        className="text-xs text-err hover:opacity-80 cursor-pointer"
                        aria-label="View error details"
                        onClick={() =>
                          setErrorDetails({
                            frameworkName: framework.name,
                            error: compilation.error as string,
                          })
                        }
                      >
                        Details
                      </button>
                    )}

                    {/* Clean compile: installs dependencies, then compiles */}
                    {!isBusy && (
                      <button
                        type="button"
                        onClick={() => handleCleanCompile(framework.id)}
                        className="btn btn-secondary text-xs flex items-center gap-1 px-2 py-1"
                        title={pin ? 'Compile this read-only version' : 'Install dependencies and compile from scratch'}
                        aria-label={`${pin ? 'Compile' : 'Clean compile'} ${framework.name}`}
                      >
                        <Hammer size={12} />
                        {pin ? 'Compile' : 'Clean compile'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Compilation error details dialog */}
      <Dialog.Root
        open={!!errorDetails}
        onOpenChange={(open) => {
          if (!open) setErrorDetails(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="dialog-overlay"
            style={{ background: 'transparent' }}
          />
          <Dialog.Content
            className="dialog-content glass-overlay"
            style={{ maxWidth: 680, width: '90vw', padding: 16 }}
          >
            <Dialog.Title className="text-lg font-medium mb-3">
              {errorDetails?.frameworkName} compilation error
            </Dialog.Title>
            <pre className="code-surface p-4 text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap text-[var(--text)]">
              {errorDetails?.error}
            </pre>
            <div className="flex items-center justify-end mt-4">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary">
                  Close
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
