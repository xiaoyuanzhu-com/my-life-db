/**
 * Digester Registry
 * Manages registered digesters and their execution order
 */

import type { Digester } from './types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigesterRegistry' });

declare global {
  var __mylifedb_digester_registry: DigesterRegistry | undefined;
}

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
    const types = new Set<string>();
    for (const digester of this.digesters) {
      const outputs = digester.getOutputDigesters?.();
      if (outputs && outputs.length > 0) {
        outputs.forEach((name) => types.add(name));
      } else {
        types.add(digester.name);
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

  /**
   * Get digester info for API/UI (name, label, outputs)
   */
  getDigesterInfo(): Array<{ name: string; label: string; outputs: string[] }> {
    return this.digesters.map((d) => ({
      name: d.name,
      label: d.label,
      outputs: d.getOutputDigesters?.() ?? [d.name],
    }));
  }
}

/**
 * Global singleton registry (stored on globalThis to survive HMR/module reloads)
 */
if (!globalThis.__mylifedb_digester_registry) {
  globalThis.__mylifedb_digester_registry = new DigesterRegistry();
}

export const globalDigesterRegistry = globalThis.__mylifedb_digester_registry;
