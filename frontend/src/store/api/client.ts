// Enhanced API client instance for the store
import { createEnhancedClient } from './enhancedClient';

// Single enhanced client instance for the entire app
export const apiClient = createEnhancedClient({ baseUrl: '' });

// Export types for convenience
export type { EnhancedClient } from './enhancedClient';
