# Obsidian

Obsidian's genius is that the vault is just a folder of plain Markdown. No export needed — the files on disk **are** the export.

## What you can export

- All notes (`.md` files)
- Attachments (images, PDFs, audio, etc.)
- Folder structure
- `.obsidian/` workspace config (hotkeys, plugins, themes) — optional

What you skip:
- Nothing. Everything is already plain files.

## Option 1 — Drag the vault folder in (recommended)

Literally the simplest import on this list.

1. Close Obsidian (safer — ensures no pending writes).
2. Find your vault folder (default: `~/Documents/<VaultName>` on Mac, or wherever you chose).
3. Drag-and-drop the entire folder onto this data page.
4. Optional: exclude `.obsidian/` and `.trash/` if you only want notes + attachments.

[Start with agent →](mld:Help me import my Obsidian vault. I'll point you to the folder. Copy it to imports/obsidian/ and advise whether to keep or drop the .obsidian/ config folder.)

## Option 2 — Symlink for live access

Keep editing in Obsidian, while MyLifeDB indexes the same files. Requires a file watcher (already built in here via the FS service).

1. In a terminal: `ln -s ~/Documents/MyVault <data-root>/imports/obsidian`.
2. MyLifeDB will watch and re-index as you edit in Obsidian.

Trade-off: deletions in Obsidian propagate to MyLifeDB's view. Back up first.

[Start with agent →](mld:Help me symlink my Obsidian vault into imports/obsidian/ for live syncing. Walk me through the ln -s command and back up first.)

## Where it lands

`imports/obsidian/` — your vault as-is.
