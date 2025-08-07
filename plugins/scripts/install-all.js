#!/usr/bin/env node

// Auto-discovery install script for all plugin dependencies
import { readdir } from "fs/promises";
import { join } from "path";
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

      // Check if it has a package.json (indicating it needs dependencies)
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

// Install dependencies for a single plugin
async function installPlugin(plugin) {
  const { name, path, type } = plugin;

  log(`📦 Installing dependencies for ${type}/${name}...`, "blue");

  try {
    execSync("npm install", {
      cwd: path,
      stdio: "inherit", // Show npm output
    });

    log(`✅ Installed: ${type}/${name}`, "green");
    return true;
  } catch (error) {
    log(`❌ Failed to install ${type}/${name}: ${error.message}`, "red");
    return false;
  }
}

// Main install function
async function installAll() {
  try {
    log("📦 Starting auto-discovery dependency installation...", "blue");

    // Find all plugin types
    const types = await findPluginTypes();
    log(`📋 Found plugin types: ${types.join(", ")}`, "yellow");

    // Find and install all plugins
    const allPlugins = [];
    let successCount = 0;

    for (const type of types) {
      const plugins = await findPluginsInType(type);
      log(
        `🔍 Found ${plugins.length} plugins in ${type}: ${plugins
          .map((p) => p.name)
          .join(", ")}`,
        "yellow",
      );
      allPlugins.push(...plugins);
    }

    // Install dependencies for each plugin
    for (const plugin of allPlugins) {
      const success = await installPlugin(plugin);
      if (success) {
        successCount++;
      }
    }

    log(
      `🎉 Installation complete! Installed dependencies for ${successCount}/${allPlugins.length} plugins.`,
      "green",
    );

    if (successCount < allPlugins.length) {
      process.exit(1);
    }
  } catch (error) {
    log(`💥 Installation failed: ${error.message}`, "red");
    process.exit(1);
  }
}

installAll();
