// Shared API contracts for frontend/backend communication
// Main export point for all API versions

// Export current stable version (v1)
export * from "./v1/index.js";

// For backwards compatibility and easy migration
export { v1Routes as apiRoutes } from "./v1/index.js";

// Future versions can be added here
// export * from './v2/index.js';
