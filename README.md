# 🚀 Ignite - Smart Contract Deployment Tool

A secure, modular smart-contract deployer with a visual workflow interface and container-based plugin system.

## 🎯 Current Status: Production-Ready Standalone Executable

Ignite now operates as a **fully self-contained executable** with:

- **🏗️ Standalone Architecture**: Single executable with embedded frontend and plugin assets
- **📦 Unified Asset Management**: Automatic gzip compression/decompression system
- **🔍 Foundry Detection**: Working project detection in both development and production
- **🐳 Container Plugins**: Docker-based plugin system with volume sharing
- **🛡️ Safety Features**: Automatic workspace mounting with sensitive directory protection
- **⚡ Optimized Performance**: Compressed assets for minimal bundle size

## 🏁 Quick Start

**Run the executable anywhere:**

```bash
# Download and run (detects foundry projects automatically)
./ignite-core-macos-x64                    # Auto-mount current directory
./ignite-core-macos-x64 --path /my/project # Mount specific project

# Safety: Won't auto-mount sensitive directories (/, ~, ~/Documents)
```

**Or develop with hot reload:**

```bash
npm install && npm run dev  # Full development environment
```

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

- Backend server on `http://localhost:1301`
- Frontend dev server on `http://localhost:1302` (which proxies to backend)

## 🏗️ Production Build

```bash
# Complete build pipeline (frontend + plugins + executable)
npm run build
```

**What happens during build:**

1. **Frontend**: Vite build with automatic gzip compression
2. **Plugins**: Auto-discovery, esbuild compilation, and gzip compression
3. **Assets**: Copy optimized assets to `dist-assets/`
4. **Core**: TypeScript compilation
5. **Package**: Create standalone executables with `pkg`

**Individual build steps:**

```bash
npm run build:frontend   # React + Vite + gzip compression
npm run build:plugins    # Auto-discover and compress all plugins
npm run build:core       # TypeScript backend compilation
npm run copy:assets      # Prepare assets for pkg bundling
npm run clean            # Clean all build artifacts
```

**Output:** Cross-platform executables in `core/dist-pkg/`

## 🏛️ Architecture

```
┌─────────────────────────────────────────┐
│ Standalone Executable (ignite-core)    │
│  • Embedded React frontend (gzipped)   │
│  • Embedded plugin bundles (gzipped)   │
│  • AssetManager (unified decompression) │
│  • Docker container orchestration      │
│  • Auto workspace mounting + safety    │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│ Container Plugin System                 │
│  repo-managers/    compilers/          │
│  ├─ local-repo     ├─ foundry          │
│  └─ cloned-repo    └─ hardhat          │
│                                         │
│  • Volume sharing via VolumesFrom      │
│  • Auto-discovery build system         │
│  • Gzip compression for optimization   │
└─────────────────────────────────────────┘
```

## 🧪 Testing & Usage

**1. Build and test the executable:**

```bash
npm run build
cd core/dist-pkg
./ignite-core-macos-x64  # (or your platform)
```

**2. Test foundry detection:**

```bash
# In a foundry project directory
./ignite-core-macos-x64
# Open http://localhost:1301 → should detect foundry automatically

# Or specify path
./ignite-core-macos-x64 --path /path/to/foundry/project
```

**3. Development mode:**

```bash
npm run dev
# Open http://localhost:1302 → hot reload enabled
```

## ✅ Current Capabilities

- **🏗️ Standalone Executables**: Self-contained, no external file dependencies
- **🔍 Framework Detection**: Automatic foundry project detection
- **📦 Asset Management**: Unified compression/decompression system
- **🐳 Plugin System**: Docker-based plugin execution with volume sharing
- **🛡️ Security**: Localhost-only access, sensitive directory protection
- **⚡ Performance**: Optimized with gzip compression, minimal bundle size
- **🔧 Developer Experience**: Hot reload, automatic browser opening, clear error messages
