#!/usr/bin/env node

// Auto-discovery Docker build script for all images
import { readdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";

const SRC_DIR = "src";

// Colors for console output
const colors = {
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Find all Dockerfiles recursively
async function findDockerfiles(dir = SRC_DIR, dockerfiles = []) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await findDockerfiles(fullPath, dockerfiles);
    } else if (entry.name === "Dockerfile") {
      dockerfiles.push(fullPath);
    }
  }

  return dockerfiles;
}

// Generate image name from Dockerfile path
function getImageName(dockerfilePath) {
  // Remove src/ prefix and Dockerfile suffix
  const pathParts = dockerfilePath
    .replace(/^src\//, "")
    .replace(/\/Dockerfile$/, "")
    .split("/");

  if (pathParts.length === 1 && pathParts[0] === "shared") {
    // shared/Dockerfile → ignite/shared
    return "ignite/shared";
  } else if (
    pathParts.length === 3 &&
    pathParts[0] === "shared" &&
    pathParts[1] === "base"
  ) {
    // shared/base/compiler/Dockerfile → ignite/base_compiler
    return `ignite/base_${pathParts[2]}`;
  } else if (pathParts.length === 2) {
    // compiler/foundry/Dockerfile → ignite/compiler_foundry
    return `ignite/${pathParts[0]}_${pathParts[1]}`;
  }

  throw new Error(`Unexpected Dockerfile path structure: ${dockerfilePath}`);
}

// Determine build order based on dependencies
function getBuildOrder(dockerfiles) {
  const imageOrder = [];

  // 1. Base shared image first
  const shared = dockerfiles.find((df) => df.includes("shared/Dockerfile"));
  if (shared) imageOrder.push(shared);

  // 2. Base plugin type images (base_*)
  const baseImages = dockerfiles.filter((df) => df.includes("shared/base/"));
  imageOrder.push(...baseImages.sort());

  // 3. Individual plugin images
  const pluginImages = dockerfiles.filter(
    (df) => !df.includes("shared/Dockerfile") && !df.includes("shared/base/"),
  );
  imageOrder.push(...pluginImages.sort());

  return imageOrder;
}

// Build a single Docker image
async function buildImage(dockerfilePath) {
  const imageName = getImageName(dockerfilePath);
  const contextDir = dirname(dockerfilePath);

  log(`🐳 Building ${imageName} from ${dockerfilePath}...`, "blue");

  try {
    const buildCmd = `docker build -t ${imageName}:latest ${contextDir}`;

    execSync(buildCmd, {
      stdio: "pipe",
    });

    log(`✅ Built: ${imageName}:latest`, "green");
    return imageName;
  } catch (error) {
    log(`❌ Failed to build ${imageName}: ${error.message}`, "red");
    return null;
  }
}

// Main build function
async function buildAllDockerImages() {
  try {
    log("🚀 Starting auto-discovery Docker build...", "blue");

    // Find all Dockerfiles
    const dockerfiles = await findDockerfiles();
    log(`📋 Found ${dockerfiles.length} Dockerfiles:`, "yellow");
    dockerfiles.forEach((df) => log(`  - ${df}`, "yellow"));

    if (dockerfiles.length === 0) {
      log("⚠️  No Dockerfiles found!", "yellow");
      return;
    }

    // Determine build order
    const buildOrder = getBuildOrder(dockerfiles);
    log("📦 Build order:", "blue");
    buildOrder.forEach((df, index) => {
      const imageName = getImageName(df);
      log(`  ${index + 1}. ${imageName} (${df})`, "blue");
    });

    // Build images in order
    const builtImages = [];
    for (const dockerfilePath of buildOrder) {
      const imageName = await buildImage(dockerfilePath);
      if (imageName) {
        builtImages.push(imageName);
      }
    }

    log(
      `🎉 Docker build complete! Built ${builtImages.length}/${dockerfiles.length} images.`,
      "green",
    );
    if (builtImages.length > 0) {
      log("📋 Built images:", "green");
      builtImages.forEach((img) => log(`  - ${img}:latest`, "green"));
    }
  } catch (error) {
    log(`💥 Docker build failed: ${error.message}`, "red");
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildAllDockerImages();
}

export { buildAllDockerImages };
