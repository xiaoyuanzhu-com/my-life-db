// Settings and configuration management for MyLifeDB

export interface UserSettings {
  // User Preferences
  preferences: {
    theme: 'light' | 'dark' | 'auto';
    defaultView: 'home' | 'library';
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    language?: 'en' | 'zh-Hans'; // UI language (BCP-47).
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

  // Integration surfaces — per-protocol toggles for non-OAuth ingestion
  // (HTTP webhook, WebDAV, S3-compatible). When a surface is off, the
  // corresponding route is not registered. Toggling requires a server
  // restart in v1.
  integrations: {
    surfaces: {
      webhook: boolean;
      webdav: boolean;
      s3: boolean;
    };
  };
}

// Default settings
export const DEFAULT_SETTINGS: UserSettings = {
  preferences: {
    theme: 'auto',
    defaultView: 'home',
    logLevel: 'info',
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
  integrations: {
    surfaces: {
      webhook: false,
      webdav: false,
      s3: false,
    },
  },
};

