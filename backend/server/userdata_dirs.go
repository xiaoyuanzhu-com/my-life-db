package server

import (
	"embed"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// userdataReadmes embeds the README content shipped into top-level
// USER_DATA_DIR subfolders. Each file in userdata_readmes/ corresponds to a
// folder name (e.g. agents.md → agents/README.md).
//
//go:embed userdata_readmes/*.md
var userdataReadmes embed.FS

// userDataDirs lists the top-level subfolders the app expects under
// USER_DATA_DIR. The README content for each lives in userdata_readmes/<name>.md.
var userDataDirs = []string{"agents", "explore", "sessions"}

// ensureUserDataDirs creates the well-known top-level USER_DATA_DIR subfolders
// (agents, explore, sessions) and seeds a README.md inside each one if the
// README is missing. Called unconditionally at startup; MkdirAll and the
// "write only if absent" check make it idempotent across runs.
//
// READMEs are only written when missing so a user can edit or delete them
// without the app clobbering their changes on the next boot.
func ensureUserDataDirs(userDataDir string) {
	for _, name := range userDataDirs {
		dir := filepath.Join(userDataDir, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Warn().Err(err).Str("path", dir).Msg("failed to ensure user data dir")
			continue
		}

		readmePath := filepath.Join(dir, "README.md")
		if _, err := os.Stat(readmePath); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			log.Warn().Err(err).Str("path", readmePath).Msg("failed to stat readme")
			continue
		}

		body, err := userdataReadmes.ReadFile("userdata_readmes/" + name + ".md")
		if err != nil {
			log.Warn().Err(err).Str("dir", name).Msg("missing embedded readme")
			continue
		}
		if err := os.WriteFile(readmePath, body, 0o644); err != nil {
			log.Warn().Err(err).Str("path", readmePath).Msg("failed to write readme")
		}
	}
}
