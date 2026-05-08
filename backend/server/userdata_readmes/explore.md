# Explore

This folder holds **explore posts** — the content shown in MyLifeDB's
explore feed.

Each post is a folder under `<author>/<yymm-slug>/` containing the post's
markdown, attachments, and metadata. The folder layout is managed by the
server; posts are normally created through the in-app composer or via
agents using the `publish-post` MCP tool.

You can browse and edit post folders by hand, but the explore feed itself
is rendered from the database (`explore_posts` / `explore_comments`) — if
you want a change to show up in the feed, do it through the app.
