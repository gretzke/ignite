#!/usr/bin/env node

// Auto-discovery build script for all plugins
import { readdir, mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { pathToFileURL } from "url";

const SRC_DIR = "src";
const DIST_DIR = "dist";
const JS_DIR = join(DIST_DIR, "js");
const COMPRESSED_DIR = join(DIST_DIR, "compressed");

process.env.IGNITE_PLUGIN_BUILD = "true";

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
      return { filePath: targetFile, plugin };
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

// Extract plugin metadata by executing the built plugin
async function extractPluginMetadata(plugin, builtFilePath) {
  try {
    // Import the built plugin module using cross-platform file URL
    const absolutePath = resolve(builtFilePath);
    const fileUrl = pathToFileURL(absolutePath).href;
    const pluginModule = await import(fileUrl);

    // Try to get the plugin class from the module
    let PluginClass = null;

    // Look for exported plugin classes
    for (const [exportName, exportValue] of Object.entries(pluginModule)) {
      if (
        exportValue &&
        typeof exportValue === "function" &&
        typeof exportValue.getInfo === "function"
      ) {
        PluginClass = exportValue;
        break;
      }
    }

    if (!PluginClass) {
      throw new Error(
        "Plugin does not export a class with static getInfo() method",
      );
    }

    // Call static getInfo() to get the plugin's metadata
    const infoResult = PluginClass.getInfo();

    if (!infoResult.success || !infoResult.data) {
      throw new Error("Plugin getInfo() returned unsuccessful result");
    }

    // Use whatever the plugin returns as its metadata
    return infoResult.data;
  } catch (error) {
    log(
      `❌ Failed to extract metadata from ${builtFilePath}: ${error.message}`,
      "red",
    );
    return null;
  }
}

// Generate plugin registry from built plugins
async function generatePluginRegistry(builtResults) {
  log("📋 Generating plugin registry...", "blue");

  const registry = {};

  for (const result of builtResults) {
    const { plugin, filePath } = result;
    const metadata = await extractPluginMetadata(plugin, filePath);
    if (metadata) {
      registry[metadata.id] = metadata;
      log(`✅ Added to registry: ${metadata.id} (${metadata.name})`, "green");
    }
  }

  // Write registry to dist directory
  const registryPath = join(DIST_DIR, "plugin-registry.json");
  await writeFile(registryPath, JSON.stringify(registry, null, 2));

  log(`📝 Plugin registry written to: ${registryPath}`, "green");
  log(`📊 Total plugins registered: ${Object.keys(registry).length}`, "blue");

  return registry;
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
        ".": {
          types: "./index.d.ts",
          default: "./index.js",
        },
        "./types": {
          types: "./types.d.ts",
          default: "./types.js",
        },
        "./base/*": {
          types: "./base/*/index.d.ts",
          default: "./base/*/index.js",
        },
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
    const builtResults = [];
    for (const plugin of allPlugins) {
      const result = await buildPlugin(plugin);
      if (result) {
        builtFiles.push(result.filePath);
        builtResults.push(result);
      }
    }

    // Generate plugin registry from built plugins
    if (builtResults.length > 0) {
      await generatePluginRegistry(builtResults);
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

buildAll();
