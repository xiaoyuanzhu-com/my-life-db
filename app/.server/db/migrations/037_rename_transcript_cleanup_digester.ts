// Rename digester: transcript-cleanup → speech-recognition-cleanup
import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 37,
  description: 'Rename transcript-cleanup digester to speech-recognition-cleanup',

  up(db: BetterSqlite3.Database) {
    console.log('[Migration 037] Renaming transcript-cleanup to speech-recognition-cleanup');

    const result = db.prepare(
      `UPDATE digests SET digester = 'speech-recognition-cleanup' WHERE digester = 'transcript-cleanup'`
    ).run();

    console.log(`[Migration 037] Updated ${result.changes} digest records`);
  },

  down(db: BetterSqlite3.Database) {
    console.log('[Migration 037] Reverting speech-recognition-cleanup to transcript-cleanup');

    const result = db.prepare(
      `UPDATE digests SET digester = 'transcript-cleanup' WHERE digester = 'speech-recognition-cleanup'`
    ).run();

    console.log(`[Migration 037] Reverted ${result.changes} digest records`);
  },
};

export default migration;
