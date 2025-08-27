// Shared utilities for artifact discovery and file system traversal
import { promises as fs } from "fs";
import { join, relative, extname, basename } from "path";

export interface FileInfo {
  path: string;
  relativePath: string;
  isDirectory: boolean;
}

// Recursively traverse a directory and return all files matching the filter
export async function traverseDirectory(
  rootPath: string,
  filter: (file: FileInfo) => boolean,
  workspaceRoot: string = rootPath,
): Promise<FileInfo[]> {
  const results: FileInfo[] = [];

  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(rootPath, entry.name);
      const relativePath = relative(workspaceRoot, fullPath);

      const fileInfo: FileInfo = {
        path: fullPath,
        relativePath,
        isDirectory: entry.isDirectory(),
      };

      if (entry.isDirectory()) {
        // Recursively traverse subdirectories
        const subResults = await traverseDirectory(
          fullPath,
          filter,
          workspaceRoot,
        );
        results.push(...subResults);
      } else if (filter(fileInfo)) {
        results.push(fileInfo);
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be read - return empty array
  }

  return results;
}

// Check if a file exists
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Read and parse a JSON file safely
export async function readJsonFile<T = any>(
  filePath: string,
): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    return null;
  }
}

// Filter for JSON artifact files
export const jsonArtifactFilter = (file: FileInfo): boolean => {
  return !file.isDirectory && extname(file.path) === ".json";
};

// Extract contract name from artifact file path
// For Foundry: "Contract.sol/Contract.json" -> "Contract"
// For Hardhat: "Contract.sol/Contract.json" -> "Contract"
export function extractContractNameFromPath(artifactPath: string): string {
  const fileName = basename(artifactPath, ".json");
  return fileName;
}
