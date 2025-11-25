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

// Task handlers (for integration)
export { digestBatchHandler, processFileDigests } from './task-handler';
export type { DigestBatchPayload } from './task-handler';
