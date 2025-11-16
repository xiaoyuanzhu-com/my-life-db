/**
 * Digester Registry
 * Manages registered digesters and their execution order
 */

import type { Digester } from './types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigesterRegistry' });

/**
 * Registry for digesters
 * Maintains ordered list - first registered = first executed
 */
export class DigesterRegistry {
  private digesters: Digester[] = [];

  /**
   * Register a new digester.
   * Order matters! Digesters execute in registration order.
   */
  register(digester: Digester): void {
    // Check for duplicate IDs
    const existing = this.digesters.find((d) => d.id === digester.id);
    if (existing) {
      throw new Error(`Digester with id '${digester.id}' already registered`);
    }

    // Validate produces array
    if (!digester.produces || digester.produces.length === 0) {
      throw new Error(`Digester '${digester.id}' must produce at least one digest type`);
    }

    this.digesters.push(digester);
    log.info(
      { id: digester.id, name: digester.name, produces: digester.produces },
      'digester registered'
    );
  }

  /**
   * Get all registered digesters in registration order
   */
  getAll(): Digester[] {
    return [...this.digesters]; // Return copy to prevent mutation
  }

  /**
   * Get digester by ID
   */
  getById(id: string): Digester | undefined {
    return this.digesters.find((d) => d.id === id);
  }

  /**
   * Get all digest types that could be produced by all digesters
   */
  getAllDigestTypes(): string[] {
    const types = new Set<string>();
    for (const digester of this.digesters) {
      for (const type of digester.produces) {
        types.add(type);
      }
    }
    return Array.from(types);
  }

  /**
   * Get count of registered digesters
   */
  count(): number {
    return this.digesters.length;
  }
}

/**
 * Global singleton registry
 */
export const globalDigesterRegistry = new DigesterRegistry();
