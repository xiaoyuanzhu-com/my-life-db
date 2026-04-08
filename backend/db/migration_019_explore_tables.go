package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     19,
		Description: "Create explore_posts and explore_comments tables",
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			_, err = tx.Exec(`
				CREATE TABLE IF NOT EXISTS explore_posts (
					id TEXT PRIMARY KEY,
					author TEXT NOT NULL,
					title TEXT NOT NULL,
					content TEXT,
					media_type TEXT,
					media_paths TEXT,
					media_dir TEXT,
					tags TEXT,
					created_at INTEGER NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			_, err = tx.Exec(`CREATE INDEX IF NOT EXISTS idx_explore_posts_created_at ON explore_posts(created_at DESC)`)
			if err != nil {
				return err
			}

			_, err = tx.Exec(`
				CREATE TABLE IF NOT EXISTS explore_comments (
					id TEXT PRIMARY KEY,
					post_id TEXT NOT NULL REFERENCES explore_posts(id) ON DELETE CASCADE,
					author TEXT NOT NULL,
					content TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			_, err = tx.Exec(`CREATE INDEX IF NOT EXISTS idx_explore_comments_post_id ON explore_comments(post_id)`)
			if err != nil {
				return err
			}

			return tx.Commit()
		},
	})
}
