export interface App {
  id: string;
  name: string;
  category: "social" | "chat" | "cloud" | "notes" | "health" | "media" | "finance" | "other";
  website?: string;
  description?: string;
  icon?: string;
  // Legacy single-prompt path; superseded by the structured `import` block on
  // AppDetail. Apps not yet migrated still set this and ship a markdown doc.
  importPrompt?: string;
}

export interface AppDetail extends App {
  doc?: string; // legacy markdown body, used when `import` is absent
  import?: ImportSpec;
}

export interface ImportSpec {
  oneOff?: ImportSection;
  continuousSync?: ImportSection;
}

export interface ImportSection {
  feasible: boolean;
  // Set when feasible === false.
  reason?: string;
  // Set when feasible === true.
  options?: ImportOption[];
}

export interface ImportOption {
  id: string;
  name: string;
  url?: string;
  description: string;
  seedPrompt: string;
}
