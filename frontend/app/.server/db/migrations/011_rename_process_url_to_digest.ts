import type BetterSqlite3 from 'better-sqlite3';

const migration = {
  version: 11,
  description: 'Rename process_url tasks to digest_url_crawl',

  async up(db: BetterSqlite3.Database) {
    db.prepare(`UPDATE tasks SET type = 'digest_url_crawl' WHERE type = 'process_url'`).run();
    db.prepare(`UPDATE inbox_task_state SET task_type = 'digest_url_crawl' WHERE task_type = 'process_url'`).run();
  },

  async down(db: BetterSqlite3.Database) {
    db.prepare(`UPDATE tasks SET type = 'process_url' WHERE type = 'digest_url_crawl'`).run();
    db.prepare(`UPDATE inbox_task_state SET task_type = 'process_url' WHERE task_type = 'digest_url_crawl'`).run();
  },
};

export default migration;

