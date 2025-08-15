import Tooltip from '../components/Tooltip';
import Dropdown from '../components/Dropdown';
import Select from '../components/Select';
import * as Dialog from '@radix-ui/react-dialog';
import { Bookmark, Plus, X, Folder, GitBranch } from 'lucide-react';
import { useRef, useState } from 'react';

interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
  };
}

export default function RepositoriesPage() {
  const [cloneModalOpen, setCloneModalOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetCloneState = () => {
    setCloneUrl('');
    setBranches([]);
    setSelectedBranch('');
    setBranchError('');
    setLoadingBranches(false);
  };

  const handleLocalRepo = async () => {
    try {
      // Use modern File System Access API if available
      if ('showDirectoryPicker' in window) {
        // const _directoryHandle =
        await (
          window as unknown as {
            showDirectoryPicker: () => Promise<{ name: string }>;
          }
        ).showDirectoryPicker();
        // console.log('Selected directory:', _directoryHandle.name);
        // TODO: Handle the directory path - _directoryHandle.name contains the folder name
      } else {
        // Fallback to traditional file input for older browsers
        fileInputRef.current?.click();
      }
    } catch {
      // User cancelled the picker or error occurred
      // console.log('Directory selection cancelled or failed');
    }
  };

  const handleFolderSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      // Extract just the directory name from the first file's path
      // const _directoryName = files[0].webkitRelativePath.split('/')[0];
      // console.log('Selected folder (fallback):', _directoryName);
      // TODO: Handle the directory path
    }
  };

  const parseGitHubUrl = (
    url: string
  ): { owner: string; repo: string } | null => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
    return null;
  };

  const fetchBranches = async (url: string) => {
    const parsed = parseGitHubUrl(url);
    if (!parsed) return;

    setLoadingBranches(true);
    setBranchError('');

    try {
      const perPage = 100;
      let page = 1;
      const allBranches: GitHubBranch[] = [];
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      while (true) {
        const response = await fetch(
          `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/branches?per_page=${perPage}&page=${page}`,
          { headers }
        );
        if (!response.ok) {
          throw new Error('Repository not found or private');
        }

        const batch: GitHubBranch[] = await response.json();
        allBranches.push(...batch);

        const link = response.headers.get('Link');
        const hasNext = !!(link && link.includes('rel="next"'));
        if (!hasNext || batch.length < perPage) break;
        page += 1;
      }

      setBranches(allBranches);

      // Let the Select component handle default selection via defaultPriority
      setSelectedBranch(''); // Clear to let Select component handle defaults
    } catch {
      setBranchError(
        'Could not fetch branches. Please check the repository URL.'
      );
      setBranches([]);
      setSelectedBranch('');
    } finally {
      setLoadingBranches(false);
    }
  };

  const handleCloneRepo = () => {
    setCloneModalOpen(true);
  };

  const handleCloneSubmit = () => {
    // For now, just log the URL and branch
    // console.log('Clone URL:', cloneUrl, 'Branch:', selectedBranch);
    setCloneModalOpen(false);
  };

  const handleCloneModalOpenChange = (open: boolean) => {
    setCloneModalOpen(open);
    if (!open) {
      resetCloneState();
    }
  };

  const handleCloneUrlChange = (url: string) => {
    setCloneUrl(url);
    if (url && parseGitHubUrl(url)) {
      fetchBranches(url);
    } else {
      setBranches([]);
      setSelectedBranch('');
      setBranchError('');
    }
  };

  const mock = {
    name: 'Current Workspace',
    path: '/path/to/project',
    saved: false,
    framework: 'Foundry',
  } as const;

  const localRepos = [
    {
      name: 'My DeFi Project',
      path: '/Users/alice/projects/defi',
      framework: 'Foundry',
    },
    {
      name: 'NFT Marketplace',
      path: '/Users/alice/projects/nft-market',
      framework: 'Hardhat',
    },
  ] as const;

  const clonedRepos = [
    {
      name: 'uniswap/v4-core',
      path: 'github.com/uniswap/v4-core',
      framework: 'Foundry',
    },
    {
      name: 'openzeppelin/openzeppelin-contracts',
      path: 'github.com/openzeppelin/openzeppelin-contracts',
      framework: 'Hardhat',
    },
  ] as const;

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="page-title">Repositories</h2>
        <Dropdown
          renderTrigger={({ ref, toggle }) => (
            <button
              ref={ref as React.MutableRefObject<HTMLButtonElement | null>}
              type="button"
              className="btn btn-primary"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Add repository"
              title="Add repository"
              onClick={toggle}
            >
              <Plus size={16} />
            </button>
          )}
          menuClassName="tooltip-content"
          menuStyle={{
            padding: 12,
            minWidth: 160,
            background:
              'color-mix(in oklch, var(--bg-base) calc(var(--glass-milk) + 20%), transparent)',
            borderColor: 'color-mix(in oklch, #fff 28%, transparent)',
          }}
        >
          {({ close }) => (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
                onClick={() => {
                  handleLocalRepo();
                  close();
                }}
              >
                <Folder size={16} />
                Local Repo
              </button>
              <button
                type="button"
                className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
                onClick={() => {
                  handleCloneRepo();
                  close();
                }}
              >
                <GitBranch size={16} />
                Cloned Repo
              </button>
            </div>
          )}
        </Dropdown>
      </div>

      {/* Current workspace row */}
      <div className="card-milky p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
              📁
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{mock.name}</div>
              <div className="text-xs opacity-70 truncate">
                {mock.path} {mock.saved ? '' : '(unsaved)'}
              </div>
            </div>
            <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
              {mock.framework}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!mock.saved && (
              <Tooltip label="Save" placement="top">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{
                    width: 40,
                    height: 36,
                    paddingLeft: 0,
                    paddingRight: 0,
                  }}
                  aria-label="Save repository"
                  title="Save"
                >
                  <Bookmark size={16} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Local repos */}
      <div className="mt-4">
        <div className="text-xs opacity-70 mb-2">Local</div>
        <div className="flex flex-col gap-2">
          {localRepos.map((r) => (
            <div key={r.name} className="card-milky p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
                    📁
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{r.name}</div>
                    <div className="text-xs opacity-70 truncate">{r.path}</div>
                  </div>
                  <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
                    {r.framework}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Tooltip label="Remove" placement="top">
                    <button
                      type="button"
                      className="btn btn-secondary btn-secondary-borderless"
                      style={{
                        width: 40,
                        height: 36,
                        paddingLeft: 0,
                        paddingRight: 0,
                      }}
                      aria-label="Remove repository"
                      title="Remove"
                    >
                      <X size={16} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Cloned repos */}
      <div className="mt-4">
        <div className="text-xs opacity-70 mb-2">Cloned</div>
        <div className="flex flex-col gap-2">
          {clonedRepos.map((r) => (
            <div key={r.name} className="card-milky p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
                    📁
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{r.name}</div>
                    <div className="text-xs opacity-70 truncate">{r.path}</div>
                  </div>
                  <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
                    {r.framework}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Tooltip label="Remove" placement="top">
                    <button
                      type="button"
                      className="btn btn-secondary btn-secondary-borderless"
                      style={{
                        width: 40,
                        height: 36,
                        paddingLeft: 0,
                        paddingRight: 0,
                      }}
                      aria-label="Remove repository"
                      title="Remove"
                    >
                      <X size={16} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Hidden file input for folder selection */}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        {...({
          webkitdirectory: '',
        } as React.InputHTMLAttributes<HTMLInputElement>)}
        multiple
        onChange={handleFolderSelect}
      />

      {/* Clone Repository Modal */}
      <Dialog.Root
        open={cloneModalOpen}
        onOpenChange={handleCloneModalOpenChange}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="dialog-overlay"
            style={{ background: 'transparent' }}
          />
          <Dialog.Content
            className="dialog-content glass-surface"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              maxWidth: 460,
              width: '90vw',
              padding: 16,
            }}
          >
            <Dialog.Title className="text-base font-semibold mb-2">
              Clone Repository
            </Dialog.Title>
            <div className="text-sm opacity-80 mb-4">
              Enter the URL of the repository you want to clone.
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">
                Repository URL
              </label>
              <input
                type="url"
                placeholder="https://github.com/username/repository"
                value={cloneUrl}
                onChange={(e) => handleCloneUrlChange(e.target.value)}
                className="input-glass"
                autoFocus
              />
            </div>

            {/* Branch Selection */}
            {branches.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">Branch</label>
                <Select
                  options={branches.map((branch) => ({
                    value: branch.name,
                    label: branch.name,
                  }))}
                  value={selectedBranch}
                  onValueChange={setSelectedBranch}
                  placeholder="Select branch..."
                  defaultPriority={['main', 'master']}
                />
              </div>
            )}

            {/* Loading State */}
            {loadingBranches && (
              <div className="mb-4 text-sm opacity-70">
                Fetching branches...
              </div>
            )}

            {/* Error State */}
            {branchError && (
              <div className="mb-4 text-sm text-red-400">{branchError}</div>
            )}
            <div className="flex items-center justify-end gap-2 mt-2">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCloneSubmit}
                disabled={
                  !cloneUrl.trim() ||
                  (branches.length > 0 && !selectedBranch) ||
                  loadingBranches
                }
              >
                Clone
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
