import { useAppSelector } from '../../../store/hooks';
import {
  selectRepositories,
  selectRepositoriesData,
  selectFailedRepositories,
} from '../../../store/features/repositories/repositoriesSlice';
import { getRepoName } from '../../../utils/repo';

// Derived view model for the repositories page: transforms the raw API data
// (RepoListEntry records) into display-ready lists and handles
// current-workspace matching.
export function useRepositoryLists() {
  const repositories = useAppSelector(selectRepositories);
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const failedRepositories = useAppSelector(selectFailedRepositories);

  const sessionPath = repositories?.session?.pathOrUrl;
  const localEntries = repositories?.local || [];

  // Check if current workspace matches any local repo
  const matchingLocalRepoIndex = sessionPath
    ? localEntries.findIndex((entry) => entry.pathOrUrl === sessionPath)
    : -1;

  const hasMatchingLocalRepo = matchingLocalRepoIndex !== -1;

  // Current workspace (only show if it doesn't match a local repo and is not failed)
  const currentWorkspace =
    sessionPath &&
    !hasMatchingLocalRepo &&
    !failedRepositories.includes(sessionPath)
      ? {
          name: 'Current Workspace',
          path: sessionPath,
          saved: false,
          frameworks: repositoriesData[sessionPath]?.frameworks,
          versions: repositories?.session?.versions ?? [],
          originUrl: repositories?.session?.originUrl,
        }
      : null;

  // Transform local repos and handle current workspace matching, filter out failed ones
  const localRepos = localEntries
    .filter((entry) => !failedRepositories.includes(entry.pathOrUrl))
    .map((entry, index) => {
      const isCurrentWorkspace = entry.pathOrUrl === sessionPath;
      return {
        name: isCurrentWorkspace
          ? `${getRepoName(entry.pathOrUrl)} (Current Workspace)`
          : getRepoName(entry.pathOrUrl),
        path: entry.pathOrUrl,
        frameworks: repositoriesData[entry.pathOrUrl]?.frameworks,
        versions: entry.versions,
        originUrl: entry.originUrl,
        isCurrentWorkspace,
        originalIndex: index,
      };
    });

  // Sort local repos to put current workspace match at the top
  localRepos.sort((a, b) => {
    if (a.isCurrentWorkspace && !b.isCurrentWorkspace) return -1;
    if (!a.isCurrentWorkspace && b.isCurrentWorkspace) return 1;
    return a.originalIndex - b.originalIndex; // Maintain original order for others
  });

  const clonedRepos =
    repositories?.cloned
      .filter((entry) => !failedRepositories.includes(entry.pathOrUrl))
      .map((entry) => ({
        name: getRepoName(entry.pathOrUrl),
        path: entry.pathOrUrl,
        frameworks: repositoriesData[entry.pathOrUrl]?.frameworks,
        versions: entry.versions,
        originUrl: entry.originUrl,
      })) || [];

  return { currentWorkspace, localRepos, clonedRepos, sessionPath };
}
