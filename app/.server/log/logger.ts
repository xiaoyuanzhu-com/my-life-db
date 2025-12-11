import pino from 'pino';

// Lightweight logger wrapper around pino with a safe fallback to console.
// Configure via env:
// - LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error' (default: 'info')
// - LOG_PRETTY: 'true' to enable pino-pretty transport if available
// - USE_PINO: 'false' to force console fallback

type PinoLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => PinoLike;
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function getLevelOrder(level: LogLevel): number {
  switch (level) {
    case 'debug': return 10;
    case 'info': return 20;
    case 'warn': return 30;
    case 'error': return 40;
    default: return 20;
  }
}

// dynamic console wrapper is defined later to reference currentLevel

function createPinoLogger(): PinoLike {
  const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) || 'info';
  // Default to pretty logs (console format) unless explicitly disabled
  const pretty = process.env.LOG_PRETTY !== 'false';
  const usePino = process.env.USE_PINO !== 'false';
  const isDev = process.env.NODE_ENV !== 'production';

  // In dev, Next.js/Turbopack often breaks pino transports (worker). Default to console wrapper
  // unless explicitly forced via USE_PINO=true.
  if (!usePino || (isDev && process.env.USE_PINO !== 'true')) {
    // Console wrapper that respects dynamic global level
    return createConsoleWrapper();
  }

  // Attempt to create pino; if transport/worker fails (e.g., Next/Turbopack), fall back to console.
  try {
    const options: any = { level: configuredLevel };
    if (pretty) {
      options.transport = {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      };
    }
    const base = pino(options) as unknown as PinoLike;
    // Wrap writes to guard against runtime worker failures
    const safe = {
      info: (obj: unknown, msg?: string) => {
        try { (base.info as any)(obj, msg); } catch { createConsoleWrapper().info(obj, msg); }
      },
      warn: (obj: unknown, msg?: string) => {
        try { (base.warn as any)(obj, msg); } catch { createConsoleWrapper().warn(obj, msg); }
      },
      error: (obj: unknown, msg?: string) => {
        try { (base.error as any)(obj, msg); } catch { createConsoleWrapper().error(obj, msg); }
      },
      debug: (obj: unknown, msg?: string) => {
        try { (base.debug as any)(obj, msg); } catch { createConsoleWrapper().debug(obj, msg); }
      },
      child: (bindings: Record<string, unknown>) => {
        try {
          const childBase = (base.child as any)(bindings) as PinoLike;
          return {
            info: (obj: unknown, msg?: string) => { try { (childBase.info as any)(obj, msg); } catch { createConsoleWrapper(bindings).info(obj, msg); } },
            warn: (obj: unknown, msg?: string) => { try { (childBase.warn as any)(obj, msg); } catch { createConsoleWrapper(bindings).warn(obj, msg); } },
            error: (obj: unknown, msg?: string) => { try { (childBase.error as any)(obj, msg); } catch { createConsoleWrapper(bindings).error(obj, msg); } },
            debug: (obj: unknown, msg?: string) => { try { (childBase.debug as any)(obj, msg); } catch { createConsoleWrapper(bindings).debug(obj, msg); } },
            child: (more: Record<string, unknown>) => safe.child({ ...bindings, ...more }),
          } as PinoLike;
        } catch {
          return createConsoleWrapper(bindings);
        }
      },
    } as PinoLike;
    return safe;
  } catch {
    return createConsoleWrapper();
  }
}

// Global dynamic level controlled by setLogLevel
let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) || 'info';
const baseLogger: PinoLike = createPinoLogger();

function should(method: LogLevel): boolean {
  return getLevelOrder(method) >= getLevelOrder(currentLevel);
}

function createConsoleWrapper(bindings: Record<string, unknown> = {}): PinoLike {
  const prefix = Object.keys(bindings).length > 0 ? `[${Object.entries(bindings).map(([k,v]) => `${k}=${String(v)}`).join(' ')}]` : '';
  return {
    info: (obj, msg) => { if (should('info')) console.log(prefix, msg || '', obj ?? ''); },
    warn: (obj, msg) => { if (should('warn')) console.warn(prefix, msg || '', obj ?? ''); },
    error: (obj, msg) => { if (should('error')) console.error(prefix, msg || '', obj ?? ''); },
    debug: (obj, msg) => { if (should('debug')) console.debug(prefix, msg || '', obj ?? ''); },
    child: (more) => createConsoleWrapper({ ...bindings, ...more }),
  };
}

export function setLogLevel(level: LogLevel): void {
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') return;
  currentLevel = level;
  try {
    // If pino is active and supports level change
    const anyLogger = baseLogger as unknown as { level?: string };
    if (anyLogger && typeof anyLogger === 'object' && 'level' in anyLogger) {
      anyLogger.level = level as unknown as string;
    }
  } catch {
    // Ignore errors when setting log level
  }
}

export function getLogger(bindings?: Record<string, unknown>): PinoLike {
  if (bindings && Object.keys(bindings).length > 0) {
    return baseLogger.child(bindings);
  }
  return baseLogger;
}
