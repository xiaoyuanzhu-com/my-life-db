# Agents

This folder holds **auto-run agent definitions** — markdown files that tell
MyLifeDB to do something automatically when a trigger fires.

Each agent is a single `.md` file with YAML frontmatter:

    ---
    name: My Agent
    agent: claude_code
    trigger: file.created      # or file.changed, file.moved, file.deleted, cron
    schedule: "0 9 * * *"      # only when trigger is "cron"
    enabled: true
    ---

    Natural-language instructions for the agent.

The body below the frontmatter is the agent's prompt — it decides whether
to act based on the trigger context it receives.

The server watches this folder; new or edited files are picked up
automatically — no restart needed. Set `enabled: false` to pause an agent
without deleting it.

The easiest way to create an agent is through the in-app composer. Editing
or hand-authoring files here works too.
