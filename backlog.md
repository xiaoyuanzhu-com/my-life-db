# Backlog

## Zero-downtime deployment

**Pain point:** Deploying a new server version kills all active Claude sessions. Users lose their in-progress work and context with no warning.

**UX requirement:** Ongoing sessions must not be interrupted by a deployment. New connections go to the new version; existing sessions continue on the old version until they finish naturally.

## Claude Code skills support

**Status:** Already works — no code changes needed.

**How it works:** Skills are filesystem-based (`~/.claude/skills/` for personal, `.claude/skills/` for project). Since `~/.claude/` is volume-mounted in our Docker deployment, skills persist across container restarts. Third-party skills (e.g. `remotion-dev/skills`) are installed via `/plugin` commands inside a Claude session. Personal skills can be authored by asking Claude to create them directly.

**Future:** Add a management UI only if we need finer control (e.g. browsing a marketplace, bulk operations, or skill versioning).
