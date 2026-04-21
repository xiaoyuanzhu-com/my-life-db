export interface App {
  id: string;
  name: string;
  category: "social" | "chat" | "cloud" | "notes" | "health" | "media" | "finance" | "other";
  website?: string;
  description?: string;
  icon?: string; // simple-icons slug; falls back to id when absent
}

export interface AppDetail extends App {
  doc?: string; // raw markdown, may be empty
}
