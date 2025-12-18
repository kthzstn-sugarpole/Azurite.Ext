const rcedit = require('rcedit');
const glob = require('glob');
const path = require('path');
const pjson = require('../package.json');
const fs = require('fs');
// the process.env definition is placed here because the code breaks when it is 
// placed after requiring pkg and pkg-fetch
process.env.PKG_CACHE_PATH = path.resolve('.\\.pkg-cache');
const pkg = require('pkg');
const pkgFetch = require('pkg-fetch');

build();

async function build() {
  const pkgTarget = 'node18-win-x64';
  const cacheExe = await downloadCache(pkgTarget);
  await rcedit(cacheExe, {
    "version-string": {
      "CompanyName": "Microsoft",
      "ProductName": "Azurite",
      "FileDescription": "Azurite",
      "ProductVersion": pjson.version,
      "OriginalFilename": "",
      "InternalName": "node",
      "LegalCopyright": "© 2021 Microsoft. All rights reserved."
    },
    // file-version is kept as the node version used by the .exe for debugging purposes
    "icon": path.resolve('.\\icon.ico')
  });

  // rename the cache file to skip hash check by pkg-fetch since hash check reverts our change of properties
  const newName = cacheExe.replace("fetched", "built");

  function asyncRename(oldName, changedName) {
    return new Promise(resolve => {
      fs.rename(oldName, changedName, response => resolve(response));
    });
  }

  await asyncRename(cacheExe, newName);

  const releaseDir = path.resolve('.\\release');
  const outputExe = path.resolve(releaseDir, 'azurite.exe');

  // Ensure release directory exists
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
  }

  await pkg.exec([path.resolve('.'), ...['--target', pkgTarget], ...['--output', outputExe], ...['-C', 'Brotli']]);

  // Copy sqlite3 native binary to release folder
  await copySqlite3Binary(releaseDir);
}

async function copySqlite3Binary(releaseDir) {
  const sqlite3Paths = [
    'node_modules\\sqlite3\\build\\Release\\node_sqlite3.node',
    'node_modules\\sqlite3\\lib\\binding\\napi-v6-win32-x64\\node_sqlite3.node',
    'node_modules\\sqlite3\\lib\\binding\\node-v108-win32-x64\\node_sqlite3.node'
  ];

  // Create sqlite3 binding directory in release folder
  const bindingDir = path.join(releaseDir, 'sqlite3');
  if (!fs.existsSync(bindingDir)) {
    fs.mkdirSync(bindingDir, { recursive: true });
  }

  let copied = false;
  for (const relativePath of sqlite3Paths) {
    const sourcePath = path.resolve(relativePath);
    if (fs.existsSync(sourcePath)) {
      const destPath = path.join(bindingDir, 'node_sqlite3.node');
      fs.copyFileSync(sourcePath, destPath);
      console.log(`Copied sqlite3 native binary: ${sourcePath} -> ${destPath}`);
      copied = true;
      break;
    }
  }

  if (!copied) {
    // Try to find any .node file in sqlite3 folder
    const nodeFiles = glob.sync('node_modules\\sqlite3\\**\\*.node');
    if (nodeFiles.length > 0) {
      const destPath = path.join(bindingDir, 'node_sqlite3.node');
      fs.copyFileSync(nodeFiles[0], destPath);
      console.log(`Copied sqlite3 native binary: ${nodeFiles[0]} -> ${destPath}`);
    } else {
      console.warn('Warning: sqlite3 native binary not found. SQLite support may not work.');
    }
  }

  console.log('SQLite3 native binary deployment complete.');
}

async function downloadCache(pkgTarget) {
  const [nodeRange, platform, arch] = pkgTarget.split('-');

  await pkgFetch.need({ nodeRange, platform, arch });
  const cacheExe = glob.sync(process.env.PKG_CACHE_PATH + "\\**\\fetched*");
  if (cacheExe.length < 1) {
    console.log('Error downloading PKG cache');
    process.exit(1);
  }
  return cacheExe[0];
}