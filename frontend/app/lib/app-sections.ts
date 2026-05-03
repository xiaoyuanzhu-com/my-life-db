import type { App } from "~/types/apps";

export type SectionKey =
  | "featured"
  | "fitness"
  | "notes"
  | "ai"
  | "chat"
  | "social"
  | "media"
  | "cloud"
  | "finance"
  | "productivity";

export const SECTION_ORDER: SectionKey[] = [
  "featured",
  "fitness",
  "notes",
  "ai",
  "chat",
  "social",
  "media",
  "cloud",
  "finance",
  "productivity",
];

// Order here is the order shown in the Featured section.
const FEATURED_ORDER: string[] = [
  "apple-health",
  "google",
  "notion",
  "telegram",
  "wechat",
];
const FEATURED_IDS = new Set<string>(FEATURED_ORDER);

const AI_IDS = new Set<string>([
  "chatgpt",
  "claude",
  "claude-code",
  "gemini",
  "copilot",
  "deepseek",
  "grok",
  "kimi",
  "doubao",
  "perplexity",
  "notebooklm",
]);

const PRODUCTIVITY_IDS = new Set<string>([
  "ticktick",
  "todoist",
  "github",
  "slack",
]);

// Maps a backend category to a section key. AI and productivity override by id.
function primarySection(app: App): SectionKey {
  if (AI_IDS.has(app.id)) return "ai";
  if (PRODUCTIVITY_IDS.has(app.id)) return "productivity";
  switch (app.category) {
    case "health":
      return "fitness";
    case "notes":
      return "notes";
    case "chat":
      return "chat";
    case "social":
      return "social";
    case "media":
      return "media";
    case "cloud":
      return "cloud";
    case "finance":
      return "finance";
    default:
      return "productivity";
  }
}

export type AppSection = { key: SectionKey; apps: App[] };

// Group apps into sections. Featured is a curated list and may repeat apps
// from other sections — every app also appears in its primary section.
export function groupAppsIntoSections(apps: App[]): AppSection[] {
  const buckets: Record<SectionKey, App[]> = {
    featured: [],
    fitness: [],
    notes: [],
    ai: [],
    chat: [],
    social: [],
    media: [],
    cloud: [],
    finance: [],
    productivity: [],
  };

  const byId = new Map<string, App>();
  for (const app of apps) {
    if (FEATURED_IDS.has(app.id)) {
      byId.set(app.id, app);
    } else {
      buckets[primarySection(app)].push(app);
    }
  }
  for (const id of FEATURED_ORDER) {
    const app = byId.get(id);
    if (app) buckets.featured.push(app);
  }

  return SECTION_ORDER
    .map((key) => ({ key, apps: buckets[key] }))
    .filter((s) => s.apps.length > 0);
}
