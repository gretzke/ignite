import type { FastifyInstance } from 'fastify';

// Health check and basic API routes
export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    return { message: 'Hello from Ignite backend!' };
  });
}
