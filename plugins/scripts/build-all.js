#!/usr/bin/env node

// Auto-discovery build script for all plugins
import { readdir, stat, mkdir, writeFile } from "fs/promises";
import { join, basename } from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";

const SRC_DIR = "src";
const DIST_DIR = "dist";
const JS_DIR = join(DIST_DIR, "js");
const COMPRESSED_DIR = join(DIST_DIR, "compressed");

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

// Ensure directories exist
async function ensureDirectories() {
  for (const dir of [DIST_DIR, JS_DIR, COMPRESSED_DIR]) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      log(`📁 Created directory: ${dir}`, "blue");
    }
  }
}

// Find all plugin types (compiler, repo-manager, etc.)
async function findPluginTypes() {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  const types = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== "shared") {
      types.push(entry.name);
    }
  }

  return types;
}

// Find all plugins within a type directory
async function findPluginsInType(type) {
  const typePath = join(SRC_DIR, type);
  const entries = await readdir(typePath, { withFileTypes: true });
  const plugins = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pluginPath = join(typePath, entry.name);
      const packageJsonPath = join(pluginPath, "package.json");

      // Check if it has a package.json (indicating it's a buildable plugin)
      if (existsSync(packageJsonPath)) {
        plugins.push({
          name: entry.name,
          path: pluginPath,
          type: type,
        });
      }
    }
  }

  return plugins;
}

// Build a single plugin
async function buildPlugin(plugin) {
  const { name, path, type } = plugin;
  const outputName = `${type}_${name}.js`;

  log(`🔨 Building ${type}/${name}...`, "blue");

  try {
    // Change to plugin directory and run build
    execSync("npm run build", {
      cwd: path,
      stdio: "pipe",
    });

    // Copy the built file to dist/js/
    const builtFile = join(path, "dist", "index.js");
    const targetFile = join(JS_DIR, outputName);

    if (existsSync(builtFile)) {
      execSync(`cp "${builtFile}" "${targetFile}"`);
      log(`✅ Built: ${outputName}`, "green");
      return targetFile;
    } else {
      throw new Error(`Built file not found: ${builtFile}`);
    }
  } catch (error) {
    log(`❌ Failed to build ${type}/${name}: ${error.message}`, "red");
    return null;
  }
}

// Compress all JS files
async function compressFiles() {
  log(`🗜️  Compressing files...`, "blue");

  try {
    execSync(`node scripts/compress.js dist/js/*.js`, {
      stdio: "pipe",
    });

    // Move compressed files to dedicated directory
    const jsFiles = await readdir(JS_DIR);
    const gzFiles = jsFiles.filter((file) => file.endsWith(".gz"));

    for (const gzFile of gzFiles) {
      const source = join(JS_DIR, gzFile);
      const target = join(COMPRESSED_DIR, gzFile);
      execSync(`mv "${source}" "${target}"`);
    }

    log(`✅ Compressed ${gzFiles.length} files to ${COMPRESSED_DIR}`, "green");
  } catch (error) {
    log(`❌ Compression failed: ${error.message}`, "red");
  }
}

// Build shared plugin types first
async function buildShared() {
  log("🔧 Building shared plugin types...", "blue");

  try {
    const sharedPath = join(SRC_DIR, "shared");

    // Build TypeScript
    execSync("npm run build", {
      cwd: sharedPath,
      stdio: "pipe",
    });

    // Copy package.json to dist folder for pkg compatibility
    const distPath = join(sharedPath, "dist");
    const packageJsonContent = {
      name: "@ignite/plugin-types",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
      exports: {
        ".": "./index.js",
        "./types": "./types.js",
        "./base/*": "./base/*.js",
      },
      files: ["*.js", "*.d.ts", "base/**"],
    };

    const packageJsonPath = join(distPath, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify(packageJsonContent, null, 2),
    );

    log("✅ Shared plugin types built successfully", "green");
  } catch (error) {
    log(`❌ Failed to build shared: ${error.message}`, "red");
    throw error;
  }
}

// Main build function
async function buildAll() {
  try {
    log("🚀 Starting auto-discovery plugin build...", "blue");

    // Build shared plugin types first
    await buildShared();

    // Ensure output directories exist
    await ensureDirectories();

    // Find all plugin types
    const types = await findPluginTypes();
    log(`📋 Found plugin types: ${types.join(", ")}`, "yellow");

    // Find and build all plugins
    const allPlugins = [];
    const builtFiles = [];

    for (const type of types) {
      const plugins = await findPluginsInType(type);
      log(
        `📦 Found ${plugins.length} plugins in ${type}: ${plugins
          .map((p) => p.name)
          .join(", ")}`,
        "yellow",
      );
      allPlugins.push(...plugins);
    }

    // Build each plugin
    for (const plugin of allPlugins) {
      const builtFile = await buildPlugin(plugin);
      if (builtFile) {
        builtFiles.push(builtFile);
      }
    }

    // Compress all built files
    if (builtFiles.length > 0) {
      await compressFiles();
    }

    log(`🎉 Build complete! Built ${builtFiles.length} plugins.`, "green");
    log(`📂 JS files: ${JS_DIR}`, "blue");
    log(`📂 Compressed files: ${COMPRESSED_DIR}`, "blue");
  } catch (error) {
    log(`💥 Build failed: ${error.message}`, "red");
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildAll();
}
