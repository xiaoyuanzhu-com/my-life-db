/**
 * Digest System Public API
 * Main exports for the digest registry system
 */

// Core components
export { DigestCoordinator } from './coordinator';
export { globalDigesterRegistry, DigesterRegistry } from './registry';
export { initializeDigesters } from './initialization';
export { findFilesNeedingDigestion } from './file-selection';
export { syncNewDigesters } from './sync';

// Types
export type { Digester } from './types';

// Task handlers (for integration)
export { digestFileHandler, digestBatchHandler } from './task-handler';
export type { DigestFilePayload, DigestBatchPayload } from './task-handler';
