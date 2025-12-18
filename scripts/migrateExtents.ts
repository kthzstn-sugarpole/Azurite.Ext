/**
 * Extent Migration Script
 * Migrates extent metadata from file system to MySQL Extents table
 * 
 * Usage: npx ts-node scripts/migrateExtents.ts <connectionURI> <storagesPath>
 * Example: npx ts-node scripts/migrateExtents.ts "mysql://root:1234@localhost:3306/pacs_storage" "C:\jpi-webpacs\SGP.WebPACS.BlobStorageServer\storages"
 */

import * as fs from 'fs';
import * as path from 'path';
import { Sequelize, QueryTypes } from 'sequelize';

interface ExtentInfo {
  id: string;
  offset: number;
  count: number;
}

interface BlobPersistency {
  blobId: number;
  blobName: string;
  persistency: string;
}

async function migrateExtents(connectionUri: string, storagesPath: string) {
  // Sanitize connection URI
  const sanitizedUri = connectionUri.split('?')[0];

  console.log('Starting extent migration...');
  console.log(`Connection: ${sanitizedUri}`);
  console.log(`Storages path: ${storagesPath}`);

  const sequelize = new Sequelize(sanitizedUri, {
    logging: false
  });

  try {
    await sequelize.authenticate();
    console.log('Database connected successfully.');

    // Get extent directory
    const extentDir = path.join(storagesPath, '__blobstorage__');
    if (!fs.existsSync(extentDir)) {
      console.error(`Extent directory not found: ${extentDir}`);
      process.exit(1);
    }

    // Get all extent files (they are files, not directories)
    const extentFiles = fs.readdirSync(extentDir, { withFileTypes: true })
      .filter(dirent => dirent.isFile())
      .map(dirent => dirent.name);

    console.log(`Found ${extentFiles.length} extent files.`);

    // Debug: show first 3 files
    console.log('Sample files:', extentFiles.slice(0, 3));

    // Get all blobs with persistency info
    const blobs = await sequelize.query<BlobPersistency>(
      'SELECT blobId, blobName, persistency FROM Blobs WHERE persistency IS NOT NULL',
      { type: QueryTypes.SELECT }
    );

    console.log(`Found ${blobs.length} blobs with persistency info.`);

    // Collect unique extent IDs from blobs
    const extentIds = new Set<string>();
    const extentInfoMap = new Map<string, ExtentInfo>();

    for (const blob of blobs) {
      try {
        const persistency = JSON.parse(blob.persistency) as ExtentInfo;
        if (persistency.id) {
          extentIds.add(persistency.id);
          if (!extentInfoMap.has(persistency.id)) {
            extentInfoMap.set(persistency.id, persistency);
          }
        }
      } catch (e) {
        console.warn(`Could not parse persistency for blob ${blob.blobName}: ${e}`);
      }
    }

    console.log(`Found ${extentIds.size} unique extent IDs referenced by blobs.`);

    // Check existing extents in DB
    const existingExtents = await sequelize.query<{ id: string }>(
      'SELECT id FROM Extents',
      { type: QueryTypes.SELECT }
    );
    const existingIds = new Set(existingExtents.map(e => e.id));
    console.log(`Found ${existingIds.size} existing extents in database.`);

    // Find missing extents
    const missingExtentIds = [...extentIds].filter(id => !existingIds.has(id));
    console.log(`Missing extents to migrate: ${missingExtentIds.length}`);

    if (missingExtentIds.length === 0) {
      console.log('No extents to migrate.');
      await sequelize.close();
      return;
    }

    // Migrate missing extents
    let migratedCount = 0;
    let errorCount = 0;

    for (const extentId of missingExtentIds) {
      // Find the extent folder by matching the beginning of the ID
      // Folders may be truncated, so match prefix
      const matchingFolder = extentFiles.find(folder => {
        // Check if folder starts with extent ID prefix or vice versa
        const idPrefix = extentId.substring(0, Math.min(30, extentId.length));
        const folderPrefix = folder.substring(0, Math.min(30, folder.length));
        return extentId.startsWith(folder) || folder.startsWith(idPrefix) ||
          folderPrefix === idPrefix;
      });

      if (!matchingFolder) {
        // Try to find folder that contains this ID anywhere
        const altMatch = extentFiles.find(folder =>
          extentId.includes(folder.substring(0, 20)) || folder.includes(extentId.substring(0, 20))
        );
        if (!altMatch) {
          console.warn(`Extent folder not found for ID: ${extentId}`);
          errorCount++;
          continue;
        }
      }

      const folderName = matchingFolder || extentFiles.find(f => extentId.startsWith(f.substring(0, 20)));
      if (!folderName) {
        errorCount++;
        continue;
      }

      const extentPath = path.join(extentDir, folderName);

      // Get file size
      let size = 0;
      try {
        const stat = fs.statSync(extentPath);
        if (stat.isDirectory()) {
          // It's a folder, list files inside
          const files = fs.readdirSync(extentPath);
          if (files.length > 0) {
            const filePath = path.join(extentPath, files[0]);
            size = fs.statSync(filePath).size;
          }
        } else {
          size = stat.size;
        }
      } catch (e) {
        console.warn(`Could not get size for extent ${extentId}: ${e}`);
      }

      // Insert into Extents table
      try {
        await sequelize.query(
          `INSERT INTO Extents (id, locationId, path, size, lastModifiedInMS) 
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE id=id`,
          {
            replacements: [
              extentId,
              'Default',
              folderName,
              size,
              Date.now()
            ],
            type: QueryTypes.INSERT
          }
        );
        migratedCount++;
        if (migratedCount % 100 === 0) {
          console.log(`Migrated ${migratedCount}/${missingExtentIds.length} extents...`);
        }
      } catch (e) {
        console.error(`Failed to insert extent ${extentId}: ${e}`);
        errorCount++;
      }
    }

    console.log('\n=== Migration Complete ===');
    console.log(`Migrated: ${migratedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total extents in DB: ${existingIds.size + migratedCount}`);

    await sequelize.close();
  } catch (error) {
    console.error('Migration failed:', error);
    await sequelize.close();
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: npx ts-node scripts/migrateExtents.ts <connectionURI> <storagesPath>');
  console.log('Example: npx ts-node scripts/migrateExtents.ts "mysql://root:1234@localhost:3306/pacs_storage" "C:\\jpi-webpacs\\storages"');
  process.exit(1);
}

migrateExtents(args[0], args[1]);
