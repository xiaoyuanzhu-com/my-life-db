# Telegram

All your chats, channels, media, and contacts — Telegram has one of the cleanest official exports in the messaging world.

## What you can export

- Personal chats (1:1 and groups)
- Channels you own or subscribe to
- Photos, videos, voice notes, files, stickers
- Contacts
- Active sessions and settings

## Option 1 — Desktop export (recommended)

Fully automated. Requires Telegram Desktop (not mobile — mobile apps don't offer export).

1. Install / open **Telegram Desktop**.
2. Menu → **Settings** → **Advanced** → **Export Telegram data**.
3. Pick what to include — for indexing, JSON is easier than HTML; for human browsing, HTML is easier.
4. Choose size limits for media (default 4GB is fine for most).
5. Wait (minutes to hours depending on history depth). Export lands in a local folder.
6. Drag the export folder into this data page.

[Start with agent →](mld:Help me import my Telegram Desktop export. Walk me through launching the export, choosing JSON vs HTML, and dropping the result into imports/telegram/.)

## Option 2 — Programmatic export via Telethon

For incremental sync, specific chats only, or custom filtering. Requires creating a `my.telegram.org` API app (free, 5 minutes).

1. Get `api_id` and `api_hash` at `my.telegram.org`.
2. Agent scaffolds a Telethon script, authenticates once via SMS code.
3. Run the script to dump selected chats as JSON.

[Start with agent →](mld:Help me set up Telethon to export specific Telegram chats. I have API credentials ready. Scaffold a Python script that dumps messages to imports/telegram/ as JSON.)

## Where it lands

`imports/telegram/` — preserves the export's `result.json` / `messages.html` + media subfolders.
