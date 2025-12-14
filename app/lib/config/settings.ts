// Settings and configuration management for MyLifeDB

export interface UserSettings {
  // User Preferences
  preferences: {
    theme: 'light' | 'dark' | 'auto';
    defaultView: 'home' | 'inbox' | 'library';
    weeklyDigest: boolean;
    digestDay: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    userEmail?: string;
  };

  // Vendor Configuration
  vendors?: {
    openai?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
    homelabAi?: {
      baseUrl?: string;
      chromeCdpUrl?: string;
    };
    meilisearch?: {
      host?: string;
    };
    qdrant?: {
      host?: string;
    };
  };

  // Digester Configuration
  digesters?: {
    'url-crawler'?: boolean;
    'url-crawl-summary'?: boolean;
    'speech-recognition'?: boolean;
    'tags'?: boolean;
    'search-keyword'?: boolean;
    'search-semantic'?: boolean;
  };

  // Extraction Options (defaults for enrichment)
  extraction: {
    autoEnrich: boolean; // Auto-enrich new entries
    includeEntities: boolean;
    includeSentiment: boolean;
    includeActionItems: boolean;
    includeRelatedEntries: boolean;
    minConfidence: number; // 0-1
  };

  // Enrichment Features (by input type)
  enrichment?: {
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
    logLevel: 'info',
  },
  digesters: {
    'url-crawler': true,
    'url-crawl-summary': true,
    'speech-recognition': true,
    'tags': true,
    'search-keyword': true,
    'search-semantic': true,
  },
  extraction: {
    autoEnrich: false,
    includeEntities: true,
    includeSentiment: true,
    includeActionItems: true,
    includeRelatedEntries: false,
    minConfidence: 0.5,
  },
  enrichment: {
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

// Helper function to mask API key with asterisks of the same length
function maskApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return apiKey;
  return '*'.repeat(apiKey.length);
}

// Sanitize settings before sending to client (mask sensitive data)
export function sanitizeSettings(settings: UserSettings): Partial<UserSettings> {
  return {
    ...settings,
    vendors: settings.vendors
      ? {
          ...settings.vendors,
          openai: settings.vendors.openai
            ? {
                ...settings.vendors.openai,
                apiKey: maskApiKey(settings.vendors.openai.apiKey),
              }
            : undefined,
        }
      : undefined,
  };
}
