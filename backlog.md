# Backlog

## Zero-downtime deployment

**Pain point:** Deploying a new server version kills all active Claude sessions. Users lose their in-progress work and context with no warning.

**UX requirement:** Ongoing sessions must not be interrupted by a deployment. New connections go to the new version; existing sessions continue on the old version until they finish naturally.

## Claude Code skills support

**Status:** Already works — no code changes needed.

**How it works:** Skills are filesystem-based (`~/.claude/skills/` for personal, `.claude/skills/` for project). Since `~/.claude/` is volume-mounted in our Docker deployment, skills persist across container restarts. Third-party skills (e.g. `remotion-dev/skills`) are installed via `/plugin` commands inside a Claude session. Personal skills can be authored by asking Claude to create them directly.

**Future:** Add a management UI only if we need finer control (e.g. browsing a marketplace, bulk operations, or skill versioning).

## Virtual scrolling for session message list

**Context:** We shipped page-based WebSocket pagination (aligned pages of 100 messages, on-demand loading on scroll-up). This solves the initial load bottleneck for large sessions (~1000 messages).

**When to revisit:** If users who load many pages still experience rendering lag after scrolling through the full history.

**Challenges:**
- Variable height rows — message blocks range from single-line status indicators to 60vh scrollable code/thinking blocks
- Height changes after render — collapsible sections (thinking, tool results, Task conversations) change height when toggled
- Nested recursion — `SessionMessages` renders recursively at `depth > 0` inside Task tool blocks
- `react-virtuoso` handles dynamic heights better than `react-window`, but collapsible state changes require re-measurement
