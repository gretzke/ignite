// Minimal RTK Query service for Ignite API
// - Exposes a single example endpoint (GET /api/v1/system/health)
// - Keeps boilerplate tiny and focused
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
// Import the canonical response types from the shared API package
import type { ApiResponse, HealthData } from '@ignite/api';

// Central API slice mounted in the Redux store under `igniteApi` key
export const igniteApi = createApi({
  reducerPath: 'igniteApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/api/v1' }),
  endpoints: (builder) => ({
    // Example query for system health check
    getHealth: builder.query<ApiResponse<HealthData>, void>({
      query: () => 'system/health',
    }),
  }),
});

// Auto-generated React hook for the endpoint above
export const { useGetHealthQuery } = igniteApi;
