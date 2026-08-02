import { Prisma } from '@prisma/client';
import { ERR, ServiceErrorCode } from './response.types';

export interface MappedPrismaError {
  error: ServiceErrorCode;
  /** Message safe to return to the client. */
  body: string;
  /** Prisma's own code, e.g. `P2002`. Null when the error carries none. */
  prismaCode: string | null;
  /** True when the message names a schema field — do not expose these in production. */
  revealsInternals: boolean;
}

/**
 * Prisma throws one opaque multi-line error for a whole family of very
 * different problems. Two passes turn that into something usable:
 *
 *   1. `extractPrismaMessage` reads the message text. This is the only thing
 *      that works for PrismaClientValidationError, which has no code and no
 *      meta — the field name only exists in prose.
 *   2. The code table below decides the HTTP status, which the text cannot.
 *
 * Message comes from (1), status from (2).
 */
export function mapPrismaError(e: unknown): MappedPrismaError | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const fromCode = mapKnownRequestError(e);
    const extracted = extractPrismaMessage(e.message);

    return {
      error: fromCode.error,
      body: extracted?.message ?? fromCode.body,
      prismaCode: e.code,
      revealsInternals: extracted?.revealsInternals ?? false,
    };
  }

  if (e instanceof Prisma.PrismaClientValidationError) {
    const extracted = extractPrismaMessage(e.message);

    return {
      // An unknown/misspelled argument is our bug, not the caller's; a missing
      // or wrongly typed value is something the caller can fix.
      error: extracted?.kind === 'schema-mismatch' ? ERR.EXCEPTION : ERR.BAD_REQUEST,
      body: extracted?.message ?? 'The request could not be processed — invalid field or value',
      prismaCode: null,
      revealsInternals: extracted?.revealsInternals ?? false,
    };
  }

  if (e instanceof Prisma.PrismaClientInitializationError) {
    return {
      error: ERR.UNAVAILABLE,
      body: 'Database is unavailable, please try again shortly',
      prismaCode: e.errorCode ?? null,
      revealsInternals: false,
    };
  }

  if (e instanceof Prisma.PrismaClientRustPanicError) {
    return {
      error: ERR.EXCEPTION,
      body: 'Database engine failure',
      prismaCode: null,
      revealsInternals: false,
    };
  }

  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    const extracted = extractPrismaMessage(e.message);
    return {
      error: ERR.EXCEPTION,
      body: extracted?.message ?? lastLine(e.message),
      prismaCode: extracted?.prismaCode ?? null,
      revealsInternals: extracted?.revealsInternals ?? true,
    };
  }

  return null;
}

// ------------------------------------------------------------ text patterns

export interface ExtractedPrismaMessage {
  message: string;
  /**
   * `schema-mismatch` — the query itself is wrong (unknown/misspelled argument).
   * `input`          — a value was missing, null or the wrong type.
   * `constraint`     — the database rejected an otherwise valid query.
   */
  kind: 'schema-mismatch' | 'input' | 'constraint' | 'unknown';
  /** Message names a schema field, so it is developer-facing. */
  revealsInternals: boolean;
  prismaCode: string | null;
}

interface Pattern {
  regex: RegExp;
  kind: ExtractedPrismaMessage['kind'];
  revealsInternals: boolean;
  message: (m: RegExpMatchArray) => string;
}

const PATTERNS: Pattern[] = [
  {
    regex: /Unknown argument `([^`]+)`/i,
    kind: 'schema-mismatch',
    revealsInternals: true,
    message: (m) => `Unknown field "${clean(m[1])}" in your Prisma query.`,
  },
  {
    regex: /Invalid value for argument `([^`]+)`.*?Expected ([\w]+)/i,
    kind: 'input',
    revealsInternals: true,
    message: (m) => `Invalid value for field "${clean(m[1])}". Expected ${m[2]}.`,
  },
  {
    regex: /Invalid value for argument `([^`]+)`/i,
    kind: 'input',
    revealsInternals: true,
    message: (m) => `Invalid value provided for field "${clean(m[1])}".`,
  },
  {
    regex: /Did you mean `([^`]+)`\?/i,
    kind: 'schema-mismatch',
    revealsInternals: true,
    message: (m) => `Unknown field used. Did you mean "${clean(m[1])}"?`,
  },
  {
    regex: /Argument `([^`]+)` is missing/i,
    kind: 'input',
    revealsInternals: true,
    message: (m) => `Missing required field "${clean(m[1])}".`,
  },
  {
    regex: /Argument `([^`]+)` must not be null/i,
    kind: 'input',
    revealsInternals: true,
    message: (m) => `Field "${clean(m[1])}" cannot be null.`,
  },
  {
    regex: /Field `([^`]+)` is required/i,
    kind: 'input',
    revealsInternals: true,
    message: (m) => `Field "${clean(m[1])}" is required.`,
  },
  {
    regex: /Record to (update|delete) (does not exist|not found)/i,
    kind: 'constraint',
    revealsInternals: false,
    message: () => 'Record not found. It may have already been changed or deleted.',
  },
  {
    regex: /depends on one or more records that were required but not found/i,
    kind: 'constraint',
    revealsInternals: false,
    message: () => 'Operation failed because a related record was not found.',
  },
  {
    regex: /Unique constraint failed on the fields?: (.+?)(?=\s|$)/i,
    kind: 'constraint',
    revealsInternals: false,
    message: (m) => `A record with this ${clean(m[1])} already exists.`,
  },
  {
    regex: /Foreign key constraint failed on the field: (.+?)(?=\s|$)/i,
    kind: 'constraint',
    revealsInternals: false,
    message: (m) => `Related record referenced by ${clean(m[1])} does not exist.`,
  },
  {
    regex: /Value too long for column|value too long for type/i,
    kind: 'input',
    revealsInternals: false,
    message: () => 'One of the values provided is too long.',
  },
];

/**
 * Pulls a readable sentence out of a raw Prisma message. Returns null when
 * nothing matched, so the caller can fall back to a code-based message rather
 * than echoing a schema dump.
 *
 * Usable directly from a service or repository:
 *   const friendly = extractPrismaMessage(e.message)?.message;
 */
export function extractPrismaMessage(raw: string): ExtractedPrismaMessage | null {
  if (!raw) return null;

  // Collapse the multi-line query dump into one line, then strip the
  // `Invalid prisma.model.op() invocation:` preamble and any stack fragment.
  const msg = raw
    .replace(/\s+/g, ' ')
    .replace(/Invalid\s+`?prisma\.[\s\S]*?invocation:?\s*/gi, '')
    .replace(/at\s+\S*PrismaClient\.\S*/g, '')
    .trim();

  if (!msg) return null;

  const prismaCode = msg.match(/\bP\d{4}\b/)?.[0] ?? null;

  for (const pattern of PATTERNS) {
    const match = msg.match(pattern.regex);
    if (match) {
      return {
        message: pattern.message(match),
        kind: pattern.kind,
        revealsInternals: pattern.revealsInternals,
        prismaCode,
      };
    }
  }

  return null;
}

// ------------------------------------------------------------- code mapping

function mapKnownRequestError(e: Prisma.PrismaClientKnownRequestError): {
  error: ServiceErrorCode;
  body: string;
} {
  const fields = targetFields(e);
  const field = fields.length > 0 ? fields.join(', ') : 'field';

  switch (e.code) {
    // ---------------------------------------------------------- connection
    case 'P1000':
    case 'P1001':
    case 'P1002':
      return { error: ERR.UNAVAILABLE, body: 'Database is unavailable, please try again shortly' };
    case 'P1008':
      return { error: ERR.UNAVAILABLE, body: 'The database took too long to respond' };
    case 'P1017':
      return { error: ERR.UNAVAILABLE, body: 'Database connection was closed, please retry' };

    // ------------------------------------------------------------- values
    case 'P2000':
      return { error: ERR.BAD_REQUEST, body: `The value provided for ${field} is too long` };
    case 'P2005':
    case 'P2006':
    case 'P2007':
      return { error: ERR.BAD_REQUEST, body: `The value provided for ${field} is not valid` };
    case 'P2011':
      return { error: ERR.BAD_REQUEST, body: `${field} cannot be empty` };
    case 'P2012':
      return { error: ERR.BAD_REQUEST, body: `Missing required value for ${field}` };
    case 'P2013':
      return { error: ERR.BAD_REQUEST, body: `Missing required argument for ${field}` };
    case 'P2019':
      return { error: ERR.BAD_REQUEST, body: 'Input error — please check the values sent' };
    case 'P2020':
      return { error: ERR.BAD_REQUEST, body: `Value out of range for ${field}` };

    // --------------------------------------------------------- constraints
    case 'P2002':
      return {
        error: ERR.CONFLICT,
        body:
          fields.length > 0
            ? `A record with this ${field} already exists`
            : 'A record with these details already exists',
      };
    case 'P2003':
      return {
        error: ERR.BAD_REQUEST,
        body: `Related record referenced by ${field} does not exist`,
      };
    case 'P2004':
      return { error: ERR.BAD_REQUEST, body: 'A database constraint rejected this change' };
    case 'P2014':
      return {
        error: ERR.BAD_REQUEST,
        body: 'This change would break a required relation between records',
      };

    // ------------------------------------------------------------ missing
    case 'P2001':
    case 'P2015':
    case 'P2018':
      return { error: ERR.NOT_FOUND, body: 'The requested record was not found' };
    case 'P2025':
      return {
        error: ERR.NOT_FOUND,
        body: modelHint(e) ?? 'The record no longer exists or was already changed',
      };

    // ------------------------------------------------------- transactions
    case 'P2034':
      return {
        error: ERR.CONFLICT,
        body: 'This record is being changed by another request, please retry',
      };

    // ------------------------------------------------------------- schema
    case 'P2021':
    case 'P2022':
      return { error: ERR.EXCEPTION, body: 'Database schema is out of date' };

    default:
      return { error: ERR.EXCEPTION, body: lastLine(e.message) };
  }
}

/** `meta.target` is the column list behind a unique / FK violation. */
function targetFields(e: Prisma.PrismaClientKnownRequestError): string[] {
  const target = (e.meta as { target?: unknown } | undefined)?.target;

  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];

  const fieldName = (e.meta as { field_name?: unknown } | undefined)?.field_name;
  return typeof fieldName === 'string' ? [fieldName] : [];
}

function modelHint(e: Prisma.PrismaClientKnownRequestError): string | null {
  const cause = (e.meta as { cause?: unknown } | undefined)?.cause;
  return typeof cause === 'string' ? cause : null;
}

/** Prisma wraps field lists as ``(`email`)`` — strip the punctuation. */
function clean(value: string): string {
  return value.replace(/[`()]/g, '').replace(/\s*,\s*/g, ', ').trim();
}

/** Prisma messages are multi-line with a schema dump — only the last line is useful. */
function lastLine(message: string): string {
  return message.split('\n').filter(Boolean).slice(-1)[0]?.trim() || message;
}
