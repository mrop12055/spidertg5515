const fs = require('fs');

const targets = fs
  .readdirSync(process.cwd(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^electron-release($|-)/.test(entry.name))
  .map((entry) => entry.name);

if (targets.length === 0) {
  console.log('[clean] no old electron-release folders found');
  process.exit(0);
}

for (const dir of targets) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log('[clean] removed', dir);
  } catch (error) {
    console.warn('[clean] skipped locked folder', dir, '-', error.code || error.message);
  }
}