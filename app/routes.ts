import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // Pages
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("inbox", "routes/inbox.tsx"),
  route("inbox/:id", "routes/inbox.$id.tsx"),
  route("library", "routes/library.tsx"),
  route("library/browse", "routes/library.browse.tsx"),
  route("file/*", "routes/file.$.tsx"),
  route("people", "routes/people.tsx"),
  route("people/:id", "routes/people.$id.tsx"),
  route("settings/*?", "routes/settings.tsx"),

  // Raw file serving
  route("raw/*", "routes/raw.$.tsx"),
  route("sqlar/*", "routes/sqlar.$.tsx"),

  // API Routes
  route("api/auth/login", "routes/api.auth.login.ts"),
  route("api/auth/logout", "routes/api.auth.logout.ts"),

  // OAuth Routes
  route("api/oauth/authorize", "routes/api.oauth.authorize.ts"),
  route("api/oauth/callback", "routes/api.oauth.callback.ts"),
  route("api/oauth/token", "routes/api.oauth.token.ts"),

  route("api/inbox", "routes/api.inbox.ts"),
  route("api/inbox/pinned", "routes/api.inbox.pinned.ts"),
  route("api/inbox/:id", "routes/api.inbox.$id.ts"),
  route("api/inbox/:id/reenrich", "routes/api.inbox.$id.reenrich.ts"),
  route("api/inbox/:id/status", "routes/api.inbox.$id.status.ts"),

  route("api/digest/digesters", "routes/api.digest.digesters.ts"),
  route("api/digest/stats", "routes/api.digest.stats.ts"),
  route("api/digest/reset/:digester", "routes/api.digest.reset.$digester.ts"),
  route("api/digest/*", "routes/api.digest.$.ts"),

  route("api/library/file", "routes/api.library.file.ts"),
  route("api/library/file-info", "routes/api.library.file-info.ts"),
  route("api/library/pin", "routes/api.library.pin.ts"),
  route("api/library/tree", "routes/api.library.tree.ts"),

  route("api/notifications/stream", "routes/api.notifications.stream.ts"),

  route("api/people", "routes/api.people.ts"),
  route("api/people/:id", "routes/api.people.$id.ts"),
  route("api/people/:id/merge", "routes/api.people.$id.merge.ts"),
  route("api/people/embeddings/:id/assign", "routes/api.people.embeddings.$id.assign.ts"),
  route("api/people/embeddings/:id/unassign", "routes/api.people.embeddings.$id.unassign.ts"),

  route("api/search", "routes/api.search.ts"),

  route("api/settings", "routes/api.settings.ts"),
  route("api/stats", "routes/api.stats.ts"),

  route("api/upload/finalize", "routes/api.upload.finalize.ts"),
  route("api/upload/tus/*?", "routes/api.upload.tus.ts"),

  route("api/directories", "routes/api.directories.ts"),
  route("api/vendors/openai/models", "routes/api.vendors.openai.models.ts"),
] satisfies RouteConfig;
