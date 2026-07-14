import fs from 'node:fs/promises';
import path from 'node:path';

await fs.mkdir('dist', { recursive: true });
await fs.copyFile(path.join('src', 'index.js'), path.join('dist', 'index.js'));
