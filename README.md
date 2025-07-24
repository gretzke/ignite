# 🚀 Ignite - Smart Contract Deployment Tool

A secure, modular smart-contract deployer with a visual workflow interface.

## Hello World Setup

This is currently a hello world app demonstrating the basic architecture:

- **Backend**: Node.js + Fastify with WebSocket support
- **Frontend**: React + Vite + TypeScript
- **Communication**: WebSockets for real-time messaging
- **Build**: pkg for creating standalone executables

## Development

**Prerequisites:**

- [Volta](https://volta.sh/) - Node.js version manager (automatically uses Node 20.x from package.json)

```bash
# Install volta if you haven't already
curl https://get.volta.sh | bash

# Clone and setup (volta will automatically use correct Node version)
npm install  # This will run postinstall hook to setup backend and frontend

# Run both frontend and backend with hot reload
npm run dev
```

This will start:

- Backend server on `http://localhost:3000`
- Frontend dev server on `http://localhost:3001` (which proxies to backend)

## Production Build

```bash
# Build everything into a single executable
npm run build
```

This will:

1. Build the frontend with Vite
2. Copy frontend dist into backend
3. Create a standalone executable with pkg

## Architecture

```
┌─────────────────────────────────────┐
│ Fastify Backend (Node.js)           │
│  • Serves frontend static files     │
│  • WebSocket communication          │
│  • REST API endpoints               │
└─────────────────────────────────────┘
           │ WebSocket/HTTP
┌─────────────────────────────────────┐
│ React Frontend (TypeScript)         │
│  • Real-time WebSocket messaging    │
│  • Modern UI with Vite              │
│  • Hot reload in development        │
└─────────────────────────────────────┘
```

## Testing the Hello World

1. Run `npm install` (sets up everything automatically)
2. Run `npm run dev`
3. Open `http://localhost:3001`
4. You should see the Ignite interface
5. Type messages in the input field to test WebSocket communication
6. Messages will be echoed back from the backend

The app demonstrates:

- ✅ Fastify backend serving React frontend
- ✅ WebSocket real-time communication
- ✅ Hot reload for both frontend and backend
- ✅ TypeScript support
- ✅ Build process that bundles everything into a single executable
- ✅ Volta for automatic Node.js version management
