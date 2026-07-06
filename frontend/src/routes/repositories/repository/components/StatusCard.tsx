import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle, Clock, AlertCircle, Loader2, Hammer } from 'lucide-react';
import { useAppDispatch } from '../../../../store/hooks';
import {
  cleanCompile,
  type CompilationStatus,
} from '../../../../store/features/compiler/compilerSlice';
import type { IFramework } from '../../../../store/features/repositories/repositoriesSlice';

interface StatusCardProps {
  repoPath: string;
  frameworks: IFramework[];
  compilations: Record<string, { status: CompilationStatus; error?: string }>;
}

export default function StatusCard({
  repoPath,
  frameworks,
  compilations,
}: StatusCardProps) {
  const dispatch = useAppDispatch();
  // Compilation error shown in the details dialog; null = closed
  const [errorDetails, setErrorDetails] = useState<{
    frameworkName: string;
    error: string;
  } | null>(null);

  const handleCleanCompile = (frameworkId: string) => {
    cleanCompile({ pathOrUrl: repoPath, pluginId: frameworkId }).forEach(
      (action) => dispatch(action)
    );
  };

  // Calculate overall status
  const getOverallStatus = (): {
    status: 'ready' | 'installing' | 'compiling' | 'error' | 'pending' | 'idle';
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
          icon: <CheckCircle size={24} className="text-green-500" />,
          color: 'text-green-500',
          bgColor: 'bg-green-500/10',
          borderColor: 'border-green-500/20',
        };
      case 'installing':
        return {
          icon: <Loader2 size={24} className="text-blue-500 animate-spin" />,
          color: 'text-blue-500',
          bgColor: 'bg-blue-500/10',
          borderColor: 'border-blue-500/20',
        };
      case 'compiling':
        return {
          icon: <Clock size={24} className="text-yellow-500" />,
          color: 'text-yellow-500',
          bgColor: 'bg-yellow-500/10',
          borderColor: 'border-yellow-500/20',
        };
      case 'error':
        return {
          icon: <AlertCircle size={24} className="text-red-500" />,
          color: 'text-red-500',
          bgColor: 'bg-red-500/10',
          borderColor: 'border-red-500/20',
        };
      default:
        return {
          icon: <Clock size={24} className="text-gray-500" />,
          color: 'text-gray-500',
          bgColor: 'bg-gray-500/10',
          borderColor: 'border-gray-500/20',
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
        <div className="mt-6 pt-6 border-t border-white/10">
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
                          ? 'bg-green-500'
                          : frameworkStatus === 'installing'
                            ? 'bg-blue-500'
                            : frameworkStatus === 'compiling'
                              ? 'bg-yellow-500'
                              : frameworkStatus === 'error'
                                ? 'bg-red-500'
                                : 'bg-gray-500'
                      }`}
                    />
                    <span className="text-sm font-medium">
                      {framework.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {(frameworkStatus !== 'idle' || frameworks.length > 1) && (
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
                        className="text-xs text-red-400 hover:text-red-300 cursor-pointer"
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
                        title="Install dependencies and compile from scratch"
                        aria-label={`Clean compile ${framework.name}`}
                      >
                        <Hammer size={12} />
                        Clean compile
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
            className="dialog-content glass-surface"
            style={{ maxWidth: 680, width: '90vw', padding: 16 }}
          >
            <Dialog.Title className="text-lg font-medium mb-3">
              {errorDetails?.frameworkName} compilation error
            </Dialog.Title>
            <pre className="bg-[var(--surface-2)] p-4 rounded-lg text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap text-[var(--text)]">
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
