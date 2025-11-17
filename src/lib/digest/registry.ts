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
    // Check for duplicate names
    const existing = this.digesters.find((d) => d.name === digester.name);
    if (existing) {
      throw new Error(`Digester with name '${digester.name}' already registered`);
    }

    this.digesters.push(digester);
    log.info(
      { name: digester.name },
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
   * Get digester by name
   */
  getByName(name: string): Digester | undefined {
    return this.digesters.find((d) => d.name === name);
  }

  /**
   * Get all digest types that could be produced by all digesters
   */
  getAllDigestTypes(): string[] {
    return this.digesters.map((d) => d.name);
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
