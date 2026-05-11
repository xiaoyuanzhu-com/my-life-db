package db

import "database/sql"

// Migration 037 — replace single-purpose `interrupted_at` with a unified
// last-turn-outcome model so cancelled / errored / interrupted are all
// first-class states and the sidebar can surface a "needs your attention"
// indicator without a per-outcome column sprawl.
//
// New columns:
//   last_turn_outcome      — '' | 'completed' | 'cancelled' | 'interrupted' | 'errored'
//   last_turn_outcome_at   — epoch ms when the outcome was recorded
//   last_error_message     — populated only when outcome='errored'
//
// The existing `interrupted_at` column (added in migration 030) is kept
// physically present for append-only migration discipline but is dead from
// this point on: no code reads or writes it. Backfill below copies its
// values into the new columns once. A future migration may drop it via the
// table-rebuild pattern when enough dead columns accumulate.
func init() {
	RegisterMigration(Migration{
		Version:     37,
		Description: "Add last_turn_outcome model to agent_sessions; backfill from interrupted_at",
		Target:      DBRoleApp,
		Up: func(db *sql.DB) error {
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN last_turn_outcome TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN last_turn_outcome_at INTEGER`); err != nil {
				return err
			}
			if _, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN last_error_message TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
			if _, err := db.Exec(`
				UPDATE agent_sessions
				SET last_turn_outcome = 'interrupted',
				    last_turn_outcome_at = interrupted_at
				WHERE interrupted_at IS NOT NULL
				  AND last_turn_outcome = ''
			`); err != nil {
				return err
			}
			return nil
		},
	})
}
