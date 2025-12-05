/**
 * Person Record - People table models
 *
 * Stores both identified (with vcf_path) and pending (without) people.
 * Pending people are auto-created during clustering; identified people
 * have a vCard file with authoritative data.
 */

/**
 * Person record row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (UUID)
 */
export interface PersonRecordRow {
  /** UUID for primary key */
  id: string;

  /** Relative path to vCard file (null = pending person) */
  vcf_path: string | null;

  /** Display name (null for pending - UI shows "Add a name") */
  display_name: string | null;

  /** Cached representative photo thumbnail (BLOB) */
  avatar: Buffer | null;

  /** ISO 8601 timestamp when created */
  created_at: string;

  /** ISO 8601 timestamp when last updated */
  updated_at: string;
}

/**
 * Person record (camelCase - for TypeScript usage)
 */
export interface PersonRecord {
  /** UUID for primary key */
  id: string;

  /** Relative path to vCard file (null = pending person) */
  vcfPath: string | null;

  /** Display name (null for pending - UI shows "Add a name") */
  displayName: string | null;

  /** Cached representative photo thumbnail (base64 encoded for API) */
  avatar: string | null;

  /** ISO 8601 timestamp when created */
  createdAt: string;

  /** ISO 8601 timestamp when last updated */
  updatedAt: string;

  /** Computed: true if vcfPath is null */
  isPending: boolean;
}

/**
 * Conversion helper: PersonRecordRow → PersonRecord
 */
export function rowToPersonRecord(row: PersonRecordRow): PersonRecord {
  return {
    id: row.id,
    vcfPath: row.vcf_path,
    displayName: row.display_name,
    avatar: row.avatar ? row.avatar.toString('base64') : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isPending: row.vcf_path === null,
  };
}

/**
 * Input for creating a new person
 */
export interface PersonInput {
  id?: string;
  vcfPath?: string | null;
  displayName?: string | null;
  avatar?: Buffer | null;
}

/**
 * Person with cluster and embedding counts for UI
 */
export interface PersonWithCounts extends PersonRecord {
  voiceClusterCount: number;
  faceClusterCount: number;
  embeddingCount: number;
}
