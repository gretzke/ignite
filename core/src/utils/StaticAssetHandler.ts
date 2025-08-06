import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AssetManager } from './AssetManager.js';
import { getLogger } from './logger.js';

export class StaticAssetHandler {
  private static instance: StaticAssetHandler;
  private readonly assetManager: AssetManager;

  private constructor() {
    this.assetManager = AssetManager.getInstance();
  }

  static getInstance(): StaticAssetHandler {
    if (!StaticAssetHandler.instance) {
      StaticAssetHandler.instance = new StaticAssetHandler();
    }
    return StaticAssetHandler.instance;
  }

  // Register the static asset handler with Fastify
  async register(app: FastifyInstance): Promise<void> {
    // Handle static assets first
    app.get('/assets/*', this.handleAssetRequest.bind(this));

    // Handle root files (index.html, favicon.ico, etc.)
    app.get('/', this.handleRootRequest.bind(this));
    app.get('/favicon.ico', this.handleAssetRequest.bind(this));
    app.get('/robots.txt', this.handleAssetRequest.bind(this));

    // SPA fallback - must be registered last
    app.setNotFoundHandler(this.handleSpaFallback.bind(this));

    getLogger().info('📁 StaticAssetHandler registered');
  }

  // Handle requests for assets (CSS, JS, images, etc.)
  private async handleAssetRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const url = request.url;
    let assetPath: string;

    if (url === '/') {
      assetPath = 'frontend/dist/index.html';
    } else {
      // Root level files like favicon.ico, robots.txt
      assetPath = `frontend/dist${url}`;
    }

    try {
      if (this.assetManager.exists(assetPath)) {
        const content = this.assetManager.getAsset(assetPath);
        const mimeType = this.assetManager.getMimeType(assetPath);

        // Set appropriate headers
        reply.type(mimeType);
        reply.header('Cache-Control', this.getCacheControl(assetPath));

        return reply.send(content);
      } else {
        return reply.code(404).send('Asset not found');
      }
    } catch (error) {
      getLogger().error(`Failed to serve asset ${assetPath}:`, error);
      return reply.code(500).send('Internal server error');
    }
  }

  // Handle root request (serve index.html)
  private async handleRootRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    return this.handleAssetRequest(request, reply);
  }

  // Handle SPA fallback (serve index.html for client-side routing)
  private async handleSpaFallback(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const url = request.url;

    // Don't handle API routes
    if (url.startsWith('/api/') || url.startsWith('/ws')) {
      return reply.code(404).send('Not found');
    }

    // For SPA routing, serve index.html
    try {
      const assetPath = 'frontend/dist/index.html';

      if (this.assetManager.exists(assetPath)) {
        const content = this.assetManager.getAsset(assetPath);

        reply.type('text/html');
        reply.header('Cache-Control', 'no-cache');

        return reply.send(content);
      } else {
        getLogger().error('index.html not found in bundled assets');
        return reply.code(404).send('Frontend not available');
      }
    } catch (error) {
      getLogger().error('Failed to serve SPA fallback:', error);
      return reply.code(500).send('Internal server error');
    }
  }

  // Get appropriate cache control header based on asset type
  private getCacheControl(assetPath: string): string {
    if (assetPath.endsWith('index.html')) {
      // Don't cache HTML files
      return 'no-cache';
    } else if (assetPath.includes('/assets/')) {
      // Cache static assets for 1 year (they have content hashes)
      return 'public, max-age=31536000, immutable';
    } else {
      // Cache other files for 1 hour
      return 'public, max-age=3600';
    }
  }

  // Static method for easy registration
  static async register(app: FastifyInstance): Promise<void> {
    const handler = StaticAssetHandler.getInstance();
    await handler.register(app);
  }
}
