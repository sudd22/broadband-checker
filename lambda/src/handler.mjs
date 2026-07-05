// =============================================================================
// UK Broadband Checker — AWS Lambda handler (Node.js 20+, ES Modules)
//
// Aligned to plan (Static_app_api_doc.md §3):
//
//   - DynamoDB partition key = normalised postcode
//   - GET /api/health returns { status: 'ok', ts: <ISO> }
//   - Response body includes source ('cache'|'live') + responseTime (ms)
//   - Cache-Control: max-age=300 on success, no-store on errors
//   - Ofcom API key fetched from SSM Parameter Store (SecureString)
//     and memoised across warm invocations
//   - X-Origin-Verify check skipped when ORIGIN_VERIFY_SECRET is unset
//
// Security posture: Zero-Trust ingress + UK GDPR-safe logging.
// Postcode is PII — only the first 8 chars of its SHA-256 hash are ever logged.
// =============================================================================

import { createHash } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

// --- Long-lived clients (one per container, reused across warm invocations) --
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ssmClient = new SSMClient({});

// --- Memoised secret (persists across warm invocations, reset on cold start) --
let cachedApiKey;

// --- Constants captured once per container ------------------------------------
const TABLE = process.env.DYNAMODB_TABLE ?? 'broadband-cache';
const PARAM = process.env.SSM_PARAM_PATH ?? '/broadband/ofcom-key';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Optional — only enforced when set. Unset = skip (unit tests, local dev).
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

// --- SSM (memoised) ----------------------------------------------------------
// Fetch the Ofcom API key once per cold container. Warm invocations reuse the
// in-memory value — no SSM round-trip per cache miss.
export async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const { Parameter } = await ssmClient.send(new GetParameterCommand({
    Name: PARAM,
    WithDecryption: true,
  }));
  cachedApiKey = Parameter?.Value;
  if (!cachedApiKey) {
    throw new Error('Ofcom API key not present in SSM parameter');
  }
  return cachedApiKey;
}

// --- Ofcom fetch -------------------------------------------------------------
// Real call to the Ofcom Broadband Coverage API. Throws on non-OK;
// the handler catches and returns 502 UPSTREAM_ERROR.
export async function fetchFromOfcom(cleanPc, apiKey) {
  const url = `https://api-proxy.ofcom.org.uk/broadband/coverage/${encodeURIComponent(cleanPc)}`;
  const response = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`Ofcom API responded with status ${response.status}`);
  }
  return response.json();
}

// --- Ofcom → app shape adapter -----------------------------------------------
// Ofcom returns each tier with numeric availability (0-100 %). We bucket it
// into the three labels the UI expects.
export function mapOfcom(pc, raw) {
  if (raw && Array.isArray(raw.Availability)) {
    const list = raw.Availability;
    const total = list.length;

    const getStats = (downKey, upKey) => {
      if (total === 0) return { maxDown: 0, maxUp: 0, availability: 'none' };

      let maxDown = 0;
      let maxUp = 0;
      let availableCount = 0;

      for (const item of list) {
        const down = item[downKey] ?? -1;
        const up = item[upKey] ?? -1;
        if (down > 0) {
          availableCount++;
          if (down > maxDown) maxDown = down;
        }
        if (up > 0) {
          if (up > maxUp) maxUp = up;
        }
      }

      const pct = (availableCount / total) * 100;
      const availability = pct > 95 ? 'full' : pct > 5 ? 'partial' : 'none';

      return { maxDown, maxUp, availability };
    };

    return {
      postcode: pc,
      standard: getStats('MaxBbPredictedDown', 'MaxBbPredictedUp'),
      superfast: getStats('MaxSfbbPredictedDown', 'MaxSfbbPredictedUp'),
      ultrafast: getStats('MaxUfbbPredictedDown', 'MaxUfbbPredictedUp'),
    };
  }

  // Fallback for flat mocked shape in unit tests
  const tier = (d) => ({
    maxDown:      d?.maxDown      ?? 0,
    maxUp:        d?.maxUp        ?? 0,
    availability: avail(d?.availability ?? 0),
  });
  const avail = (pct) => pct > 95 ? 'full' : pct > 5 ? 'partial' : 'none';
  return {
    postcode:  pc,
    standard:  tier(raw?.standard),
    superfast: tier(raw?.superfast),
    ultrafast: tier(raw?.ultrafast),
  };
}

// --- Handler -----------------------------------------------------------------
export const handler = async (event) => {
  const path = event.requestContext?.http?.path ?? '';

  // 1. ZERO-TRUST INGRESS VERIFICATION (skipped when secret unset)
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
      Key: { postcode: pc }, // normalised postcode
    }));

    if (Item && Item.ttl > Math.floor(Date.now() / 1000)) {
      const responseTime = Date.now() - t0;
      log('INFO', { pc_hash: pcHash, source: 'cache', durationMs: responseTime });
      return respond(200, { ...Item.data, source: 'cache', responseTime });
    }

    // 6. CACHE MISS → SSM → OFCOM → WRITE-BACK (fire-and-forget per plan)
    const apiKey = await getApiKey();
    const raw = await fetchFromOfcom(pc, apiKey);
    const data = mapOfcom(pc, raw);

    docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        postcode: pc,
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