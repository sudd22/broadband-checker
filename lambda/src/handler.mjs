// =============================================================================
// UK Broadband Checker — AWS Lambda handler (Node.js 20+, ES Modules)
//
// Aligned to plan (docs/Static_app_api_doc.md §3) — Phase 3 divergence fixes:
//
//   D1  DynamoDB partition key = normalised postcode (not pcHash)
//   D2  GET /api/health returns { status: 'ok', ts: <ISO> }
//   D3  Response body includes source ('cache'|'live') + responseTime (ms)
//   D4  Cache-Control: max-age=300 on success, no-store on errors
//   D5  Ofcom call replaced with deterministic mock (no API key available)
//   D6  SSM dependency removed entirely
//   D7  Keeps @aws-sdk/lib-dynamodb (cleaner than the plan's raw client)
//   D8  X-Origin-Verify check is skipped when ORIGIN_VERIFY_SECRET is unset
//
// Security posture: Zero-Trust ingress + UK GDPR-safe logging.
// Postcode is PII — only the first 8 chars of its SHA-256 hash are ever logged.
// =============================================================================

import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

// --- Long-lived clients (one per container, reused across warm invocations) --
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// --- Constants captured once per container ------------------------------------
const TABLE = process.env.DYNAMODB_TABLE ?? 'broadband-cache';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Optional — only enforced when set. Unset = skip the check (e.g. unit tests
// run without injecting a secret, and the bootstrap local-dev scenario works).
const ORIGIN_SECRET = process.env.ORIGIN_VERIFY_SECRET;

// Full UK postcode regex (post-normalisation: no spaces, uppercase)
const POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-BD-HJLNP-UW-Z]{2}$/;

// --- Helpers (exported so unit tests can exercise them in isolation) ---------

/** Strip whitespace + uppercase + trim. Idempotent. "sw1a 1aa" -> "SW1A1AA" */
export function normalise(raw) {
  return (raw ?? '').replace(/\s+/g, '').toUpperCase().trim();
}

/** First 8 chars of SHA-256 of the cleaned postcode. Safe to log. */
export function hashPostcode(clean) {
  return createHash('sha256').update(clean).digest('hex').slice(0, 8);
}

/** Case-insensitive header lookup. API Gateway lower-cases header keys. */
export function getHeader(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/** Build an API Gateway proxy response with Cache-Control defaults per plan. */
export function respond(statusCode, body, cacheControl = 'max-age=300') {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    body: JSON.stringify(body),
  };
}

/** Structured JSON log line. Never logs the postcode. */
export function log(level, data) {
  console.log(JSON.stringify({ level, ts: new Date().toISOString(), ...data }));
}

// --- Mock Ofcom (deterministic by postcode) ----------------------------------
// Three fixed coverage profiles picked deterministically from a hash of the
// cleaned postcode. Shape matches the real Ofcom response so swapping in a
// real `fetch` later is a single-function change.
const MOCK_PROFILES = [
  // Profile 0 — full ultrafast (London-ish)
  {
    standard:  { maxDown: 17.2,  maxUp: 2.1,  availability: 'full'    },
    superfast: { maxDown: 80.0,  maxUp: 20.0, availability: 'full'    },
    ultrafast: { maxDown: 330.0, maxUp: 50.0, availability: 'full'    },
  },
  // Profile 1 — superfast partial
  {
    standard:  { maxDown: 12.0,  maxUp: 1.0,  availability: 'full'    },
    superfast: { maxDown: 72.0,  maxUp: 18.0, availability: 'partial' },
    ultrafast: { maxDown: 0,     maxUp: 0,    availability: 'none'    },
  },
  // Profile 2 — USO scenario (standard only)
  {
    standard:  { maxDown: 9.4,   maxUp: 0.8,  availability: 'partial' },
    superfast: { maxDown: 0,     maxUp: 0,    availability: 'none'    },
    ultrafast: { maxDown: 0,     maxUp: 0,    availability: 'none'    },
  },
];

export function fetchFromMock(cleanPc) {
  // Normalise inside the mock so case/whitespace variants hit the same profile
  // (deterministic). The caller usually passes an already-normalised postcode,
  // but this guards against callers passing raw input.
  const normalised = normalise(cleanPc);
  const hash = createHash('sha256').update(normalised).digest('hex');
  const profile = parseInt(hash.substring(0, 2), 16) % MOCK_PROFILES.length;
  const { standard, superfast, ultrafast } = MOCK_PROFILES[profile];
  return { postcode: normalised, standard, superfast, ultrafast };
}

// --- Handler -----------------------------------------------------------------
export const handler = async (event) => {
  const path = event.requestContext?.http?.path ?? '';

  // 1. ZERO-TRUST INGRESS VERIFICATION (skipped when secret is unset)
  if (ORIGIN_SECRET) {
    const provided = getHeader(event.headers, 'X-Origin-Verify');
    if (!provided || provided !== ORIGIN_SECRET) {
      return respond(403, {
        error: 'FORBIDDEN',
        message: 'Direct access is not permitted',
      }, 'no-store');
    }
  }

  // 2. HEALTH ENDPOINT — short-circuits before postcode logic
  if (path === '/api/health' || path === '/health') {
    return respond(200, { status: 'ok', ts: new Date().toISOString() }, 'no-store');
  }

  // 3. ROUTE CHECK — only /api/check and /check reach the postcode logic
  if (path !== '/api/check' && path !== '/check') {
    return respond(404, { error: 'NOT_FOUND', message: 'Route not found' }, 'no-store');
  }

  // 4. POSTCODE EXTRACTION + NORMALISATION + VALIDATION
  const rawPc = (event.queryStringParameters?.pc ?? '').toString();
  const pc = normalise(rawPc);

  if (!POSTCODE_RE.test(pc)) {
    return respond(400, {
      error: 'INVALID_POSTCODE',
      message: 'Provide a valid UK postcode e.g. SW1A1AA',
    }, 'no-store');
  }

  const pcHash = hashPostcode(pc);
  const t0 = Date.now();

  // 5. CACHE-ASIDE READ
  try {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { postcode: pc }, // D1: key = normalised postcode (e.g. "SW1A1AA")
    }));

    if (Item && Item.ttl > Math.floor(Date.now() / 1000)) {
      const responseTime = Date.now() - t0;
      log('INFO', { pc_hash: pcHash, source: 'cache', durationMs: responseTime });
      return respond(200, { ...Item.data, source: 'cache', responseTime });
    }

    // 6. MOCK FETCH + WRITE-BACK (fire-and-forget per plan)
    const data = fetchFromMock(pc);

    docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        postcode: pc, // D1: same key as the Get
        data,
        ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_SECONDS,
      },
    })).catch((e) => log('ERROR', { msg: 'DynamoDB PutItem failed', err: e.message }));

    const responseTime = Date.now() - t0;
    log('INFO', { pc_hash: pcHash, source: 'live', durationMs: responseTime });
    return respond(200, { ...data, source: 'live', responseTime });
  } catch (err) {
    log('ERROR', { pc_hash: pcHash, msg: 'Lookup failed', err: err.message });
    return respond(502, {
      error: 'UPSTREAM_ERROR',
      message: 'Service is temporarily unavailable, please try again later.',
    }, 'no-store');
  }
};