/**
 * Digest System Public API
 * Main exports for the digest registry system
 */

// Core components
export { DigestCoordinator } from './coordinator';
export { globalDigesterRegistry, DigesterRegistry } from './registry';
export { initializeDigesters } from './initialization';
export { findFilesNeedingDigestion } from './file-selection';
export { ensureAllDigesters, ensureAllDigestersForExistingFiles } from './ensure';

// Types
export type { Digester } from './types';

// Processing helper (for API endpoints)
export { processFileDigests } from './task-handler';
