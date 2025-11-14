const fs = require('fs');
const path = require('path');

const INBOX_DIR = path.join(__dirname, 'data', 'inbox');

function migrateInbox() {
  console.log('Starting inbox migration...\n');

  const items = fs.readdirSync(INBOX_DIR);
  let stats = {
    filesSkipped: 0,
    foldersProcessed: 0,
    digestDirsDeleted: 0,
    metadataDeleted: 0,
    filesMoved: 0,
    filesSkippedConflict: 0,
    emptyFoldersDeleted: 0,
    foldersKept: 0
  };

  for (const item of items) {
    // Skip hidden files like .DS_Store
    if (item.startsWith('.')) {
      continue;
    }

    const itemPath = path.join(INBOX_DIR, item);
    const stat = fs.statSync(itemPath);

    // Skip files - they're already in correct format
    if (stat.isFile()) {
      stats.filesSkipped++;
      console.log(`✓ Skipped file: ${item}`);
      continue;
    }

    // Process folders
    if (stat.isDirectory()) {
      console.log(`\nProcessing folder: ${item}`);
      stats.foldersProcessed++;

      // Delete digest subdirectory if present
      const digestPath = path.join(itemPath, 'digest');
      if (fs.existsSync(digestPath)) {
        fs.rmSync(digestPath, { recursive: true, force: true });
        stats.digestDirsDeleted++;
        console.log(`  - Deleted digest/ directory`);
      }

      // Delete metadata.json if present
      const metadataPath = path.join(itemPath, 'metadata.json');
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
        stats.metadataDeleted++;
        console.log(`  - Deleted metadata.json`);
      }

      // Check remaining files/folders in the directory
      const remainingItems = fs.readdirSync(itemPath).filter(f => !f.startsWith('.'));

      if (remainingItems.length === 0) {
        // Empty folder - delete it (use recursive to handle hidden files)
        fs.rmSync(itemPath, { recursive: true, force: true });
        stats.emptyFoldersDeleted++;
        console.log(`  - Deleted empty folder`);
      } else if (remainingItems.length === 1) {
        const singleItemPath = path.join(itemPath, remainingItems[0]);
        const singleItemStat = fs.statSync(singleItemPath);

        // Only move if it's a file (not a subfolder)
        if (singleItemStat.isFile()) {
          const fileExtension = path.extname(remainingItems[0]);
          const newFileName = item + fileExtension;
          const newFilePath = path.join(INBOX_DIR, newFileName);

          // Check for name conflict
          if (fs.existsSync(newFilePath)) {
            stats.filesSkippedConflict++;
            console.log(`  ⚠ Skipped move (conflict): ${newFileName} already exists`);
          } else {
            // Move file to inbox root
            fs.renameSync(singleItemPath, newFilePath);
            // Delete now-empty folder (use recursive to handle hidden files)
            fs.rmSync(itemPath, { recursive: true, force: true });
            stats.filesMoved++;
            console.log(`  ✓ Moved file: ${item}/${remainingItems[0]} → ${newFileName}`);
          }
        } else {
          stats.foldersKept++;
          console.log(`  - Kept folder (contains subfolder)`);
        }
      } else {
        stats.foldersKept++;
        console.log(`  - Kept folder (contains ${remainingItems.length} items)`);
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Migration Summary:');
  console.log('='.repeat(60));
  console.log(`Files skipped (already good):     ${stats.filesSkipped}`);
  console.log(`Folders processed:                ${stats.foldersProcessed}`);
  console.log(`  - digest/ directories deleted:  ${stats.digestDirsDeleted}`);
  console.log(`  - metadata.json files deleted:  ${stats.metadataDeleted}`);
  console.log(`  - Files moved to inbox root:    ${stats.filesMoved}`);
  console.log(`  - Files skipped (conflict):     ${stats.filesSkippedConflict}`);
  console.log(`  - Empty folders deleted:        ${stats.emptyFoldersDeleted}`);
  console.log(`  - Folders kept (multiple items):${stats.foldersKept}`);
  console.log('='.repeat(60));
}

// Run migration
try {
  migrateInbox();
  console.log('\n✓ Migration completed successfully!');
} catch (error) {
  console.error('\n✗ Migration failed:', error.message);
  process.exit(1);
}
