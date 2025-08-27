// Helper function to extract name from path
export const getRepoName = (path: string) => {
  if (path.includes('github.com/')) {
    return path.split('/').slice(-2).join('/');
  }
  return path.split('/').pop() || path;
};
