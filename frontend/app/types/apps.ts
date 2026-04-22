export interface App {
  id: string;
  name: string;
  category: "social" | "chat" | "cloud" | "notes" | "health" | "media" | "finance" | "other";
  website?: string;
  description?: string;
  icon?: string;
  // Optional. Seed prompt for the "Start import" button in the import dialog.
  // Set in YAML for apps that support agent-driven import (e.g. via a public
  // API). Apps without it are manual-export only.
  importPrompt?: string;
}

export interface AppDetail extends App {
  doc?: string; // raw markdown, may be empty
}
