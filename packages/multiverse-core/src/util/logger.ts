/**
 * Multiverse Logger — structured logging with levels
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: LogLevel = 'info';

export const setLogLevel = (level: LogLevel) => {
  minLevel = level;
};

const shouldLog = (level: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];

const timestamp = () => new Date().toISOString().slice(11, 23);

let jsonMode = process.env.MV_LOG_JSON === 'true';

export const setJsonMode = (enabled: boolean) => {
  jsonMode = enabled;
};

const emit = (level: string, ctx: string, msg: string, data?: unknown) => {
  if (jsonMode) {
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, ctx, msg };
    if (data !== undefined && data !== '') {
      entry.data =
        data instanceof Error
          ? data.message
          : typeof data === 'object' && data !== null
            ? data
            : data;
    }
    console.log(JSON.stringify(entry));
    return;
  }

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`${timestamp()} [${level.toUpperCase().padEnd(5)}] [${ctx}] ${msg}`, data ?? '');
};

export const mvLog = {
  debug: (ctx: string, msg: string, data?: unknown) => {
    if (shouldLog('debug')) emit('debug', ctx, msg, data);
  },
  info: (ctx: string, msg: string, data?: unknown) => {
    if (shouldLog('info')) emit('info', ctx, msg, data);
  },
  warn: (ctx: string, msg: string, data?: unknown) => {
    if (shouldLog('warn')) emit('warn', ctx, msg, data);
  },
  error: (ctx: string, msg: string, err?: unknown) => {
    if (shouldLog('error')) emit('error', ctx, msg, err);
  },
  timed: (ctx: string, msg: string, startMs: number) => {
    if (shouldLog('info')) emit('info', ctx, `${msg} (${Date.now() - startMs}ms)`);
  },
};
