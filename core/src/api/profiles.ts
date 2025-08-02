import type { FastifyInstance } from 'fastify';
import type { ProfileManager } from '../filesystem/ProfileManager.js';

// Profile management API routes
export async function registerProfileRoutes(
  app: FastifyInstance,
  profileManager: ProfileManager
) {
  // Get all profiles
  app.get('/api/profiles', async () => {
    const profiles = await profileManager.listProfiles();
    return { profiles };
  });

  // Get current profile
  app.get('/api/profiles/current', async () => {
    const currentProfile = profileManager.getCurrentProfile();
    const config = await profileManager.getCurrentProfileConfig();
    return { name: currentProfile, config };
  });

  // Create new profile
  app.post('/api/profiles', async (request) => {
    const { name } = request.body as { name: string };

    if (!name || typeof name !== 'string') {
      throw new Error('Profile name is required');
    }

    await profileManager.createProfile(name);
    return { success: true, message: `Profile '${name}' created successfully` };
  });

  // Switch profile
  app.post('/api/profiles/switch', async (request) => {
    const { name } = request.body as { name: string };

    if (!name || typeof name !== 'string') {
      throw new Error('Profile name is required');
    }

    await profileManager.switchProfile(name);
    return { success: true, message: `Switched to profile '${name}'` };
  });
}
