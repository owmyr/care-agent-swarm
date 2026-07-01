import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export const DEFAULT_PHI_FIELDS = [
  'ssn',
  'socialSecurityNumber',
  'dob',
  'dateOfBirth',
  'diagnosis',
  'diagnoses',
  'medications',
  'medication',
  'mrn',
  'medicalRecordNumber',
  'apiKey',
  'api_key',
  'token',
  'password',
  'creditCard',
  'phoneNumber',
  'email',
  'address',
] as const;

export const DEFAULT_REDACT_PATHS = [
  ...DEFAULT_PHI_FIELDS.map((f) => `*.${f}`),
  ...DEFAULT_PHI_FIELDS.map((f) => `**.${f}`),
  'requestBody.*.content.*.input.ssn',
  'responseBody.*.content.*.text',
  '*.content',
];

export interface LoggerFactoryOptions {
  level?: string;
  redactPaths?: string[];
  name?: string;
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerFactoryOptions = {}): Logger {
  const config: LoggerOptions = {
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    name: options.name ?? 'accodal',
    redact: {
      paths: options.redactPaths ?? DEFAULT_REDACT_PATHS,
      censor: '[REDACTED]',
    },
    base: { ...(options.base ?? {}) },
  };
  return pino(config);
}

let _defaultLogger: Logger | undefined;
let _defaultLevel: string | undefined;
export function defaultLogger(level?: string): Logger {
  if (!_defaultLogger || (level && level !== _defaultLevel)) {
    _defaultLogger = createLogger({ level: level ?? _defaultLevel });
    _defaultLevel = level ?? _defaultLevel;
  }
  return _defaultLogger;
}
