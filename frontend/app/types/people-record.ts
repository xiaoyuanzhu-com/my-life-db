/**
 * People Record - People table models
 *
 * Stores both identified (with vcf_path) and pending (without) people.
 * Pending people are auto-created during clustering; identified people
 * have a vCard file with authoritative data.
 */

/**
 * People record row (snake_case - matches SQLite schema exactly)
 *
 * Primary key: id (UUID)
 */
export interface PeopleRecordRow {
  /** UUID for primary key */
  id: string;

  /** Relative path to vCard file (null = pending people) */
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
 * People record (camelCase - for TypeScript usage)
 */
export interface PeopleRecord {
  /** UUID for primary key */
  id: string;

  /** Relative path to vCard file (null = pending people) */
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
 * Conversion helper: PeopleRecordRow → PeopleRecord
 */
export function rowToPeopleRecord(row: PeopleRecordRow): PeopleRecord {
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
 * Input for creating a new people entry
 */
export interface PeopleInput {
  id?: string;
  vcfPath?: string | null;
  displayName?: string | null;
  avatar?: Buffer | null;
}

/**
 * People with cluster and embedding counts for UI
 */
export interface PeopleWithCounts extends PeopleRecord {
  voiceClusterCount: number;
  faceClusterCount: number;
  embeddingCount: number;
}
