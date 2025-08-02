#!/usr/bin/env node

// Simple script to gzip JavaScript bundles for pkg bundling
import { createReadStream, createWriteStream, existsSync } from "fs";
import { createGzip } from "zlib";
import { resolve } from "path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node compress.js <file1> [file2] ...");
  process.exit(1);
}

// Compress each provided file
for (const filePath of args) {
  const resolvedPath = resolve(filePath);

  if (!existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    continue;
  }

  const gzPath = `${resolvedPath}.gz`;

  try {
    const readStream = createReadStream(resolvedPath);
    const writeStream = createWriteStream(gzPath);
    const gzip = createGzip({ level: 9 }); // Maximum compression

    readStream.pipe(gzip).pipe(writeStream);

    writeStream.on("finish", () => {
      console.log(`✅ Compressed: ${filePath} → ${gzPath}`);
    });

    writeStream.on("error", (error) => {
      console.error(`❌ Failed to compress ${filePath}:`, error);
    });
  } catch (error) {
    console.error(`❌ Failed to compress ${filePath}:`, error);
  }
}
