import 'server-only';

import { tq } from './index';
import { getHandler, unregisterHandler } from './executor';
import { getWorker } from './worker';
import type { TaskHandler } from './types';
import { getLogger } from '@/lib/log/logger';

type TaskHandlerDefinition<TPayload = unknown> = {
  type: string;
  module: string;
  handler: TaskHandler<TPayload>;
};

const log = getLogger({ module: 'TaskHandlerRegistry' });
const definitions = new Map<string, TaskHandlerDefinition>();

export function defineTaskHandler<TPayload = unknown>(
  definition: TaskHandlerDefinition<TPayload>
): TaskHandlerDefinition<TPayload> {
  definitions.set(definition.type, definition as TaskHandlerDefinition);
  attachHandler(definition as TaskHandlerDefinition);
  return definition;
}

export function ensureTaskHandlersRegistered(types?: string[]): void {
  const targetTypes = types ?? Array.from(definitions.keys());
  targetTypes.forEach(type => {
    const definition = definitions.get(type);
    if (!definition) {
      log.warn({ type }, 'no task handler definition found for ensure');
      return;
    }

    const existing = getHandler(type);
    if (existing === definition.handler) {
      return;
    }

    attachHandler(definition);
  });
}

export function ensureTaskWorkerRunning(): void {
  const worker = getWorker();
  if (worker.isRunning()) {
    return;
  }

  worker.start();
  log.info({}, 'task queue worker auto-started');
}

export function ensureTaskRuntimeReady(types?: string[]): void {
  ensureTaskHandlersRegistered(types);
  ensureTaskWorkerRunning();
}

export function getDefinedTaskTypes(): string[] {
  return Array.from(definitions.keys());
}

function attachHandler(definition: TaskHandlerDefinition): void {
  const existing = getHandler(definition.type);
  if (existing === definition.handler) {
    return;
  }

  if (existing) {
    unregisterHandler(definition.type);
  }

  tq(definition.type).setWorker(definition.handler);
  log.info({ type: definition.type, module: definition.module }, 'task handler registered');
}
