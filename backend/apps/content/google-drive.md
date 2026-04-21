# Google Drive

Everything in your Drive — files, Google Docs / Sheets / Slides, shared drives, and metadata.

## What you can export

- All files you own in My Drive
- Google-native files (Docs/Sheets/Slides) — converted to Office or PDF on export
- Shared drives you're a member of
- Comments and revision history (Takeout only, limited)
- File metadata (starred, trash, creation time)

## Option 1 — Google Takeout (recommended for one-shot)

The official export. Fully automatic from Google's side, though large accounts take hours and split into multiple zips.

1. Go to [takeout.google.com](https://takeout.google.com).
2. **Deselect all**, then tick **Drive**.
3. Click **All Drive data included** to filter (formats, specific folders). Default is fine for a full dump.
4. Choose export format:
   - **.zip** for ≤50GB chunks, multiple files if larger.
   - **Google Docs → docx** (safer long-term than keeping `.gdoc` shortcut files).
5. Click **Create export**. Wait for the email (hours to days for large accounts).
6. Download all parts via the email's links (expire in 7 days).
7. Drop the zips into this data page.

[Start with agent →](mld:Help me import a Google Takeout Drive export. I have the zip files downloaded. Walk me through unpacking into imports/google-drive/ and flattening any multi-part archives.)

## Option 2 — rclone sync (recommended for incremental / ongoing)

Mirrors your Drive to local disk and keeps it in sync. Best if you want the data live, not frozen at a point in time.

1. Install `rclone` (`brew install rclone`).
2. Run `rclone config` → choose `drive` → follow OAuth flow.
3. Sync: `rclone copy mydrive:/ ./imports/google-drive/ -P`.
4. Schedule via cron or an auto-run agent for ongoing sync.

[Start with agent →](mld:Help me set up rclone to sync my Google Drive into imports/google-drive/. Walk me through OAuth, then set up an auto-run agent to sync daily.)

## Where it lands

`imports/google-drive/` — preserves Drive folder structure.
