const fs = require('fs');
const path = require('path');
const packager = require('@electron/packager');

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = `electron-release-${stamp}`;

  console.log('[pack] output folder:', outDir);

  const appPaths = await packager({
    dir: process.cwd(),
    name: 'TelegramCRM',
    platform: 'win32',
    arch: 'x64',
    out: outDir,
    asar: true,
    overwrite: false,
    ignore: [
      /^\/src(?:\/|$)/,
      /^\/public(?:\/|$)/,
      /^\/supabase(?:\/|$)/,
      /^\/electron-release(?:-|\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/\.lovable(?:\/|$)/,
      /^\/\.env$/,
    ],
  });

  const appPath = appPaths[0] || path.join(outDir, 'TelegramCRM-win32-x64');
  const exePath = path.join(appPath, 'TelegramCRM.exe');
  fs.writeFileSync('electron-release-latest.txt', exePath + '\n');

  console.log('[pack] build complete');
  console.log('[pack] app:', exePath);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});