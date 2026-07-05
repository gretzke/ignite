// Helper function to extract name from path
export const getRepoName = (path: string) => {
  if (path.includes('github.com/')) {
    return path.split('/').slice(-2).join('/');
  }
  return path.split('/').pop() || path;
};

// Validation helpers
export const isValidUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

export const isValidAbsolutePath = (value: string): boolean => {
  // Check if path is absolute (starts with / on Unix or C:\ on Windows)
  const trimmedPath = value.trim();
  return (
    trimmedPath.startsWith('/') || // Unix/macOS absolute path
    /^[A-Za-z]:[\\]/.test(trimmedPath) // Windows absolute path (C:\, D:\, etc.)
  );
};
