import type { ArtifactLocation } from '@ignite/api';

export interface DirectoryNode {
  name: string;
  path: string;
  type: 'directory' | 'source' | 'artifact';
  children: { [name: string]: DirectoryNode };
  artifacts?: ArtifactLocation[];
}

export interface FileNode extends DirectoryNode {
  type: 'source' | 'artifact';
  artifact: ArtifactLocation;
  identity: string;
}

/**
 * Build a hierarchical directory tree from flat artifact paths
 * Only includes source files (contracts), not artifacts
 */
export function buildPathTree(artifacts: ArtifactLocation[]): DirectoryNode {
  const root: DirectoryNode = {
    name: '',
    path: '',
    type: 'directory',
    children: {},
  };

  // One row per contract: foundry multi-solc builds emit a versioned
  // artifact JSON next to the canonical one (SwapProxy.json plus
  // SwapProxy.0.8.17.json) for the same (sourcePath, contractName). Keep the
  // shortest artifactPath — the unversioned, canonical build output.
  const canonical = new Map<string, ArtifactLocation>();
  artifacts.forEach((artifact) => {
    const key = `${artifact.sourcePath}:${artifact.contractName}`;
    const existing = canonical.get(key);
    if (
      !existing ||
      artifact.artifactPath.length < existing.artifactPath.length
    ) {
      canonical.set(key, artifact);
    }
  });

  canonical.forEach((artifact) => {
    // Only add source files (contracts), skip artifacts
    addPathToTree(root, artifact.sourcePath, 'source', artifact);
  });

  return root;
}

/**
 * Add a single path to the tree structure
 */
function addPathToTree(
  root: DirectoryNode,
  filePath: string,
  fileType: 'source' | 'artifact',
  artifact: ArtifactLocation
): void {
  const pathParts = filePath.split('/').filter((part) => part.length > 0);
  let currentNode = root;

  // Navigate/create directory structure
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    const currentPath = pathParts.slice(0, i + 1).join('/');

    if (!currentNode.children[part]) {
      currentNode.children[part] = {
        name: part,
        path: currentPath,
        type: 'directory',
        children: {},
      };
    }
    currentNode = currentNode.children[part];
  }

  // Add the file node
  const fileName = pathParts[pathParts.length - 1];
  if (fileName) {
    const identity = `${artifact.artifactPath}:${artifact.contractName}`;
    const fileNode: FileNode = {
      name: fileName,
      path: filePath,
      type: fileType,
      children: {},
      artifact,
      identity,
    };

    // If a file with this name already exists, we need to handle it
    // This can happen when source and artifact have the same relative path structure
    // A Solidity source can contain several deployable contracts. Keep one
    // row per artifact identity instead of collapsing by source path.
    currentNode.children[`${fileName}:${identity}`] = fileNode;
  }
}

/**
 * Find all file nodes in the tree (for search/filtering)
 */
export function getFileNodes(node: DirectoryNode): FileNode[] {
  const files: FileNode[] = [];

  if (node.type !== 'directory') {
    files.push(node as FileNode);
  }

  Object.values(node.children).forEach((child) => {
    files.push(...getFileNodes(child));
  });

  return files;
}

/**
 * Find a specific node by path
 */
export function findNodeByPath(
  root: DirectoryNode,
  targetPath: string
): DirectoryNode | null {
  if (root.path === targetPath) {
    return root;
  }

  for (const child of Object.values(root.children)) {
    const found = findNodeByPath(child, targetPath);
    if (found) {
      return found;
    }
  }

  return null;
}

/**
 * Get all directory paths for expansion state management
 */
export function getAllDirectoryPaths(node: DirectoryNode): string[] {
  const paths: string[] = [];

  if (node.type === 'directory' && node.path) {
    paths.push(node.path);
  }

  Object.values(node.children).forEach((child) => {
    paths.push(...getAllDirectoryPaths(child));
  });

  return paths;
}

/**
 * Get direct children of a directory for card-based navigation
 */
export function getDirectoryContents(
  root: DirectoryNode,
  directoryPath: string = ''
): { directories: DirectoryNode[]; files: FileNode[] } {
  const targetNode =
    directoryPath === '' ? root : findNodeByPath(root, directoryPath);

  if (!targetNode || targetNode.type !== 'directory') {
    return { directories: [], files: [] };
  }

  const directories: DirectoryNode[] = [];
  const files: FileNode[] = [];

  Object.values(targetNode.children).forEach((child) => {
    if (child.type === 'directory') {
      directories.push(child);
    } else {
      files.push(child as FileNode);
    }
  });

  // Sort directories first, then files
  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return { directories, files };
}
