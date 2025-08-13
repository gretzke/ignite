import Tooltip from '../components/Tooltip';
import { Bookmark, Plus, X } from 'lucide-react';

export default function RepositoriesPage() {
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
        <Tooltip label="Add repository" placement="top">
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
            aria-label="Add repository"
            title="Add repository"
          >
            <Plus size={16} />
          </button>
        </Tooltip>
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
            <span className="text-xs rounded-full pill-white px-2 py-0.5 ml-2 shrink-0">
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
                  <span className="text-xs rounded-full pill-white px-2 py-0.5 ml-2 shrink-0">
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
                  <span className="text-xs rounded-full pill-white px-2 py-0.5 ml-2 shrink-0">
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
    </div>
  );
}
