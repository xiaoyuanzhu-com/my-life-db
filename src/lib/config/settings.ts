// Settings and configuration management for MyLifeDB

export interface AIConfig {
  // AI Provider Selection
  provider: 'openai' | 'ollama' | 'custom' | 'none';

  // OpenAI Configuration
  openai?: {
    apiKey: string;
    baseUrl?: string; // Optional custom base URL
    model?: string; // e.g., "gpt-4", "gpt-3.5-turbo"
    embeddingModel?: string; // e.g., "text-embedding-3-small"
  };

  // Ollama Configuration
  ollama?: {
    baseUrl: string; // e.g., "http://localhost:11434"
    model: string; // e.g., "llama2", "mistral"
    embeddingModel?: string; // e.g., "nomic-embed-text"
  };

  // Custom API Configuration
  custom?: {
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    model?: string;
  };
}

export interface UserSettings {
  // User Preferences
  preferences: {
    theme: 'light' | 'dark' | 'auto';
    defaultView: 'home' | 'inbox' | 'library';
    weeklyDigest: boolean;
    digestDay: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
  };

  // AI Configuration
  ai: AIConfig;

  // Vendor Configuration
  vendors?: {
    openai?: {
      baseUrl?: string;
      apiKey?: string;
    };
    homelabAi?: {
      baseUrl?: string;
    };
  };

  // Extraction Options (defaults for processing)
  extraction: {
    autoProcess: boolean; // Auto-process new entries
    includeEntities: boolean;
    includeSentiment: boolean;
    includeActionItems: boolean;
    includeRelatedEntries: boolean;
    minConfidence: number; // 0-1
  };

  // Processing Features (by input type)
  processing?: {
    text?: {
      entityExtraction: boolean;
      autoTagging: boolean;
      embeddings: boolean;
    };
    url?: {
      contentCrawl: boolean;
      screenshot: boolean;
      metadataExtraction: boolean;
      embeddings: boolean;
    };
    image?: {
      captioning: boolean;
      ocr: boolean;
      embeddings: boolean;
    };
    audio?: {
      transcription: boolean; // ASR
      speakerDiarization: boolean;
      timestampExtraction: boolean;
      embeddings: boolean;
    };
    video?: {
      audioTranscription: boolean;
      frameCaptioning: boolean;
      embeddings: boolean;
    };
    pdf?: {
      textExtraction: boolean;
      ocr: boolean; // for scanned PDFs
      metadataExtraction: boolean;
      embeddings: boolean;
    };
  };

  // Storage Configuration
  storage: {
    dataPath: string;
    backupPath?: string;
    autoBackup: boolean;
    maxFileSize: number; // MB
  };
}

// Default settings
export const DEFAULT_SETTINGS: UserSettings = {
  preferences: {
    theme: 'auto',
    defaultView: 'home',
    weeklyDigest: false,
    digestDay: 0, // Sunday
  },
  ai: {
    provider: 'none',
  },
  extraction: {
    autoProcess: false,
    includeEntities: true,
    includeSentiment: true,
    includeActionItems: true,
    includeRelatedEntries: false,
    minConfidence: 0.5,
  },
  processing: {
    text: {
      entityExtraction: true,
      autoTagging: true,
      embeddings: true,
    },
    url: {
      contentCrawl: true,
      screenshot: true,
      metadataExtraction: true,
      embeddings: true,
    },
    image: {
      captioning: true,
      ocr: true,
      embeddings: true,
    },
    audio: {
      transcription: true,
      speakerDiarization: false,
      timestampExtraction: true,
      embeddings: true,
    },
    video: {
      audioTranscription: true,
      frameCaptioning: true,
      embeddings: true,
    },
    pdf: {
      textExtraction: true,
      ocr: true,
      metadataExtraction: true,
      embeddings: true,
    },
  },
  storage: {
    dataPath: './data',
    autoBackup: false,
    maxFileSize: 50, // 50 MB
  },
};

// Validate AI configuration
export function validateAIConfig(config: AIConfig): { valid: boolean; error?: string } {
  if (config.provider === 'openai') {
    if (!config.openai?.apiKey) {
      return { valid: false, error: 'OpenAI API key is required' };
    }
  }

  if (config.provider === 'ollama') {
    if (!config.ollama?.baseUrl) {
      return { valid: false, error: 'Ollama base URL is required' };
    }
    if (!config.ollama?.model) {
      return { valid: false, error: 'Ollama model is required' };
    }
  }

  if (config.provider === 'custom') {
    if (!config.custom?.baseUrl) {
      return { valid: false, error: 'Custom API base URL is required' };
    }
  }

  return { valid: true };
}

// Sanitize settings before saving (remove sensitive data from logs)
export function sanitizeSettings(settings: UserSettings): Partial<UserSettings> {
  return {
    ...settings,
    ai: {
      ...settings.ai,
      openai: settings.ai.openai
        ? {
            ...settings.ai.openai,
            apiKey: settings.ai.openai.apiKey ? '***' : undefined,
          }
        : undefined,
      custom: settings.ai.custom
        ? {
            ...settings.ai.custom,
            apiKey: settings.ai.custom.apiKey ? '***' : undefined,
          }
        : undefined,
    },
    vendors: settings.vendors
      ? {
          ...settings.vendors,
          openai: settings.vendors.openai
            ? {
                ...settings.vendors.openai,
                apiKey: settings.vendors.openai.apiKey ? '***' : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}
