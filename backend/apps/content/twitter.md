# Twitter / X

Your posts, replies, likes, bookmarks, DMs, and media — everything your account ever produced or saved.

## What you can export

- Tweets (own + replies) as JSON
- Likes and bookmarks
- Direct messages (text + attachments)
- Media you uploaded (images, videos)
- Follower / following lists
- Account metadata (profile history, devices, IP log)

## Option 1 — Official archive (recommended)

Ships everything in a single `.zip`. Semi-automatic: you click the request, X emails you ~24 hours later with a download link.

1. Open X → **Settings and privacy** → **Your account** → **Download an archive of your data**.
2. Re-enter your password, confirm via SMS/email, click **Request archive**.
3. Wait for the email (typically 24h, can be up to 72h). The link expires in ~7 days.
4. Download the zip. It contains `data/*.js` files (JSON with a prefix) plus a `tweets_media/` folder.
5. Drop the whole zip into this page's data folder — keep the original structure.

[Start with agent →](mld:Help me import my Twitter archive. I have the zip downloaded. Walk me through unpacking it into imports/twitter/ and explain what each .js file contains.)

## Option 2 — Scrape a public profile with an agent

For import without an account (e.g. someone else's public posts, a historical account). Uses a scraper library like `snscrape` or Playwright. Agent-driven.

1. Identify the handle(s) and time range.
2. Ask the agent to run the scraper and land results as NDJSON.

[Start with agent →](mld:Scrape public tweets from a Twitter handle I'll give you using snscrape, save results as NDJSON under imports/twitter/.)

## Where it lands

`imports/twitter/` — original zip structure preserved.
