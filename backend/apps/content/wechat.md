# WeChat

The hardest app on this list to export. WeChat has no first-party data export; everything involves prying data out of local SQLite databases the app stores on your device.

## What you can (partially) export

- Chat history (text, voice notes, images, files, videos)
- Contacts
- Moments (朋友圈) posts — harder, often requires screen-capture workflows
- Official Account articles you've read — usually impossible to retrieve after the fact

WeChat encrypts its local DB with a key derived from your UIN + IMEI. You'll need the key to read anything.

## Option 1 — iOS backup + iMazing + WeChatExporter (recommended for iPhone users)

Rips chat SQLite DBs out of an unencrypted iTunes backup. Requires a Mac or Windows PC.

1. Create an **unencrypted** iTunes/Finder backup of your iPhone while WeChat is logged in.
2. Open the backup with **iMazing** (free for browsing). Navigate to **Apps → WeChat → Documents**.
3. Extract `MM.sqlite` and `WCDB_Contact.sqlite` plus the `Message/` folder.
4. Use a tool like **WeChatExporter** or **wechat-dump** to decrypt and export to HTML/JSON.
5. Drop the decrypted output into this data page.

[Start with agent →](mld:Help me import WeChat chats from an iOS backup. I'll point you to the extracted SQLite files. Walk me through decrypting them and exporting to readable JSON/HTML under imports/wechat/.)

## Option 2 — Mac WeChat local DB

macOS WeChat stores DBs at `~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/<version>/<userhash>/Message/`. Works similarly to the iOS path but with a different encryption scheme.

[Start with agent →](mld:Help me locate and decrypt my Mac WeChat message databases. Export readable chat history to imports/wechat/.)

## Option 3 — Screen recording for Moments

Moments (朋友圈) history is essentially unexportable. If preserving it matters, the only path is scrolling while screen-recording, then running OCR.

[Start with agent →](mld:I have a screen recording of scrolling through my WeChat Moments. Extract the posts using OCR and save as text + screenshots under imports/wechat/moments/.)

## Where it lands

`imports/wechat/` — decrypted chat archives, Moments screenshots, contacts.
