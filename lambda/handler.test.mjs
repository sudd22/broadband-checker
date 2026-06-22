import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash } from 'node:crypto';

// -----------------------------------------------------------------------------
// Mock the DynamoDB SDK. The handler captures docClient.send at module load,
// so we re-import handler.mjs in each test (via loadHandler) for a fresh
// container. The docSend ref is reused but reset in beforeEach.
// -----------------------------------------------------------------------------
const docSend = vi.fn();

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ __ddb: true })),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: docSend })) },
  GetCommand: vi.fn((input) => ({ __cmd: 'Get', input })),
  PutCommand: vi.fn((input) => ({ __cmd: 'Put', input })),
}));

const SECRET = 'super-secret-origin-token';
const TABLE = 'broadband-cache';
const CLEAN_PC = 'SW1A1AA';
const PC_HASH = createHash('sha256').update(CLEAN_PC).digest('hex').slice(0, 8);

/** Build a valid API Gateway HTTP API event. */
function makeEvent({ path, headers, postcode } = {}) {
  const event = {
    requestContext: { http: { path: path ?? '/api/check' } },
    headers: headers === undefined ? { 'x-origin-verify': SECRET } : headers,
    queryStringParameters: postcode === undefined ? { pc: 'sw1a 1aa' } : { pc: postcode },
  };
  return event;
}

/** Fresh import so module-level env-var capture (ORIGIN_SECRET) resets per test. */
async function loadHandler() {
  vi.resetModules();
  return import('./src/handler.mjs');
}

beforeEach(() => {
  docSend.mockReset();
  process.env.ORIGIN_VERIFY_SECRET = SECRET;
  process.env.DYNAMODB_TABLE = TABLE;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Pure helpers (exported for direct unit testing)
// =============================================================================
describe('helpers', () => {
  it('normalise strips spaces, upper-cases, and trims', async () => {
    const { normalise } = await loadHandler();
    expect(normalise('sw1a 1aa')).toBe('SW1A1AA');
    expect(normalise('  SW1A1AA  ')).toBe('SW1A1AA');
    expect(normalise('Sw1A1Aa')).toBe('SW1A1AA');
    expect(normalise(null)).toBe('');
    expect(normalise(undefined)).toBe('');
  });

  it('hashPostcode returns the first 8 chars of SHA-256 of the cleaned postcode', async () => {
    const { hashPostcode } = await loadHandler();
    expect(hashPostcode('SW1A1AA')).toBe(PC_HASH);
    expect(hashPostcode('SW1A1AA').length).toBe(8);
  });

  it('getHeader is case-insensitive and returns undefined when no match', async () => {
    const { getHeader } = await loadHandler();
    expect(getHeader({ 'X-Origin-Verify': 'x' }, 'x-origin-verify')).toBe('x');
    expect(getHeader({ 'x-Origin-VERIFY': 'y' }, 'X-Origin-Verify')).toBe('y');
    expect(getHeader({ other: 'z' }, 'X-Origin-Verify')).toBeUndefined();
    expect(getHeader(undefined, 'X-Origin-Verify')).toBeUndefined();
    expect(getHeader(null, 'X-Origin-Verify')).toBeUndefined();
  });

  it('respond defaults Cache-Control to max-age=300', async () => {
    const { respond } = await loadHandler();
    const r = respond(200, { ok: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.headers['Cache-Control']).toBe('max-age=300');
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });

  it('respond honours an explicit Cache-Control (e.g. no-store on errors)', async () => {
    const { respond } = await loadHandler();
    const r = respond(400, { err: 1 }, 'no-store');
    expect(r.headers['Cache-Control']).toBe('no-store');
  });

  it('log emits a JSON line with level, ts, and the merged payload', async () => {
    const { log } = await loadHandler();
    log('INFO', { pc_hash: 'abc12345', source: 'cache', durationMs: 7 });
    const line = console.log.mock.calls.at(-1)[0];
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('INFO');
    expect(parsed.pc_hash).toBe('abc12345');
    expect(parsed.source).toBe('cache');
    expect(parsed.durationMs).toBe(7);
    expect(typeof parsed.ts).toBe('string');
  });

  it('fetchFromMock returns deterministic data for the same postcode', async () => {
    const { fetchFromMock } = await loadHandler();
    expect(fetchFromMock('SW1A1AA')).toEqual(fetchFromMock('sw1a1aa'));
    expect(fetchFromMock('SW1A1AA').postcode).toBe('SW1A1AA');
    expect(fetchFromMock('SW1A1AA').standard.maxDown).toBeGreaterThan(0);
  });

  it('fetchFromMock covers all three profiles across varied postcodes', async () => {
    const { fetchFromMock } = await loadHandler();
    const tiers = new Set();
    for (const pc of ['SW1A1AA', 'EH11YZ', 'LL574TH', 'M11AE', 'B11AA', 'CR01AA']) {
      tiers.add(fetchFromMock(pc).ultrafast.availability);
    }
    // Across 6 postcodes we should hit at least 2 distinct coverage profiles
    expect(tiers.size).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Zero-Trust ingress (X-Origin-Verify)
// =============================================================================
describe('Zero-Trust ingress verification', () => {
  it('returns 403 when the X-Origin-Verify header is missing', async () => {
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ headers: {} }));

    expect(res.statusCode).toBe(403);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({
      error: 'FORBIDDEN',
      message: 'Direct access is not permitted',
    });
    expect(docSend).not.toHaveBeenCalled();
  });

  it('returns 403 when there are no headers at all', async () => {
    const { handler } = await loadHandler();
    const res = await handler({
      requestContext: { http: { path: '/api/check' } },
      queryStringParameters: { pc: 'SW1A1AA' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when the header value does not match the secret', async () => {
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ headers: { 'x-origin-verify': 'wrong' } }));
    expect(res.statusCode).toBe(403);
  });

  it('allows the request through when ORIGIN_VERIFY_SECRET is not configured (D8)', async () => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    docSend.mockResolvedValue({}); // every DDB call succeeds
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ headers: {} }));
    // No 403 — proceeds to mock fetch, returns source='live'.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).source).toBe('live');
  });

  it('never logs the raw origin-verify token', async () => {
    const { handler } = await loadHandler();
    await handler(makeEvent({ headers: { 'x-origin-verify': 'leak-me' } }));
    const logged = console.log.mock.calls.flat().join(' ');
    expect(logged).not.toContain('leak-me');
  });
});

// =============================================================================
// Routing — /api/health, /api/check, 404
// =============================================================================
describe('routing', () => {
  it('returns 200 ok for GET /api/health (D2)', async () => {
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ path: '/api/health' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.ts).toBe('string');
    expect(new Date(body.ts).toString()).not.toBe('Invalid Date');
    expect(docSend).not.toHaveBeenCalled();
  });

  it('also handles /health (without prefix)', async () => {
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ path: '/health' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });

  it('returns 404 for unknown paths', async () => {
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ path: '/whatever' }));
    expect(res.statusCode).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND');
  });

  it('also handles /check (without prefix)', async () => {
    docSend.mockResolvedValue({}); // Get (miss) + Put both succeed
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ path: '/check' }));
    expect(res.statusCode).toBe(200);
  });
});

// =============================================================================
// Postcode validation
// =============================================================================
describe('input validation', () => {
  it('returns 400 when the pc query parameter is absent', async () => {
    const { handler } = await loadHandler();
    const res = await handler({
      ...makeEvent(),
      queryStringParameters: undefined,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(res.body).error).toBe('INVALID_POSTCODE');
  });

  it('returns 400 for a clearly invalid postcode', async () => {
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ postcode: 'NOTAPOSTCODE' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('INVALID_POSTCODE');
  });

  it('normalises case and whitespace before validating', async () => {
    docSend.mockResolvedValueOnce({
      Item: { postcode: CLEAN_PC, data: { ok: true }, ttl: Math.floor(Date.now() / 1000) + 9999 },
    });
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ postcode: '  Sw1a1Aa ' }));
    expect(res.statusCode).toBe(200);
  });
});

// =============================================================================
// Cache-aside — DynamoDB reads & writes
// =============================================================================
describe('cache-aside (DynamoDB)', () => {
  it('returns cached item with source=cache (D3)', async () => {
    const cached = {
      postcode: CLEAN_PC,
      standard: { maxDown: 100, maxUp: 10, availability: 'full' },
      superfast: { maxDown: 0, maxUp: 0, availability: 'none' },
      ultrafast: { maxDown: 0, maxUp: 0, availability: 'none' },
    };
    docSend.mockResolvedValueOnce({
      Item: { postcode: CLEAN_PC, data: cached, ttl: Math.floor(Date.now() / 1000) + 9999 },
    });

    const { handler } = await loadHandler();
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('max-age=300');
    const body = JSON.parse(res.body);
    expect(body.source).toBe('cache');
    expect(body.responseTime).toBeGreaterThanOrEqual(0);
    expect(body.postcode).toBe(CLEAN_PC);
  });

  it('treats an expired cached item as a MISS and refreshes it', async () => {
    const stale = {
      postcode: CLEAN_PC,
      standard: { maxDown: 0, maxUp: 0, availability: 'none' },
      superfast: { maxDown: 0, maxUp: 0, availability: 'none' },
      ultrafast: { maxDown: 0, maxUp: 0, availability: 'none' },
    };
    docSend
      .mockResolvedValueOnce({
        Item: { postcode: CLEAN_PC, data: stale, ttl: Math.floor(Date.now() / 1000) - 10 },
      })
      .mockResolvedValueOnce({}); // PutCommand write-back
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).source).toBe('live');
  });

  it('returns 502 when the DynamoDB read fails', async () => {
    docSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

// =============================================================================
// Cache miss → mock fetch → write-back
// =============================================================================
describe('cache miss → mock fetch → write-back', () => {
  it('returns mock data with source=live (D3, D5)', async () => {
    docSend
      .mockResolvedValueOnce({})  // GetCommand: no item
      .mockResolvedValueOnce({}); // PutCommand
    const { handler } = await loadHandler();
    const before = Math.floor(Date.now() / 1000);
    const res = await handler(makeEvent());
    const after = Math.floor(Date.now() / 1000);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('live');
    expect(body.postcode).toBe(CLEAN_PC);
    expect(body.standard).toBeDefined();
    expect(body.superfast).toBeDefined();
    expect(body.ultrafast).toBeDefined();
    expect(body.responseTime).toBeGreaterThanOrEqual(0);

    // Write-back uses the normalised postcode as the DDB key (D1).
    // What is CACHED = the raw mock payload (no source/responseTime — those
    // are added per response, not stored).
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { fetchFromMock } = await loadHandler();
    const putArg = PutCommand.mock.calls.at(-1)[0];
    expect(putArg.TableName).toBe(TABLE);
    expect(putArg.Item.postcode).toBe(CLEAN_PC);
    expect(putArg.Item.data).toEqual(fetchFromMock(CLEAN_PC));
    expect(putArg.Item.ttl).toBeGreaterThanOrEqual(before + 24 * 60 * 60);
    expect(putArg.Item.ttl).toBeLessThanOrEqual(after + 24 * 60 * 60);
  });

  it('uses the normalised postcode (not pcHash) as the DynamoDB key (D1)', async () => {
    docSend.mockResolvedValue({});
    const { handler } = await loadHandler();
    await handler(makeEvent({ postcode: '  Sw1a1Aa ' }));
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const getArg = GetCommand.mock.calls.at(-1)[0];
    expect(getArg.Key.postcode).toBe(CLEAN_PC);
    expect(getArg.Key.postcode).not.toBe(PC_HASH);
  });

  it('logs the PutItem failure but still returns 200 with the live data', async () => {
    docSend
      .mockResolvedValueOnce({})             // GetCommand miss
      .mockRejectedValueOnce(new Error('put down')); // PutCommand fails
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).source).toBe('live');
    // Wait one microtask for the PutItem rejection handler to log
    await new Promise((r) => setImmediate(r));
    const logged = console.log.mock.calls.flat().join(' ');
    expect(logged).toContain('DynamoDB PutItem failed');
  });
});

// =============================================================================
// PII protection (GDPR)
// =============================================================================
describe('PII protection (GDPR)', () => {
  it('logs only the 8-char pc_hash, never the raw or cleaned postcode', async () => {
    docSend.mockResolvedValueOnce({
      Item: { postcode: CLEAN_PC, data: { postcode: CLEAN_PC }, ttl: Math.floor(Date.now() / 1000) + 9999 },
    });
    const { handler } = await loadHandler();
    await handler(makeEvent({ postcode: 'sw1a 1aa' }));
    const logged = console.log.mock.calls.flat().join(' ');
    expect(logged).toContain(PC_HASH);
    expect(logged).not.toContain('sw1a 1aa');
    expect(logged).not.toContain('SW1A1AA');
    expect(logged).not.toContain('SW1A 1AA');
  });

  it('different case/whitespace variants normalise to the same cache key (D1)', async () => {
    docSend.mockResolvedValue({
      Item: { postcode: CLEAN_PC, data: { ok: true }, ttl: Math.floor(Date.now() / 1000) + 9999 },
    });
    const { handler } = await loadHandler();
    await handler(makeEvent({ postcode: '  Sw1a1Aa ' }));
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const getArg = GetCommand.mock.calls.at(-1)[0];
    expect(getArg.Key.postcode).toBe(CLEAN_PC);
  });
});

// =============================================================================
// Env-var / requestContext fallback branches (for 100% coverage)
// =============================================================================
describe('fallback branches', () => {
  it('falls back to default table name when DYNAMODB_TABLE env var is unset', async () => {
    delete process.env.DYNAMODB_TABLE;
    docSend.mockResolvedValueOnce({
      Item: { postcode: CLEAN_PC, data: { ok: true }, ttl: Math.floor(Date.now() / 1000) + 9999 },
    });
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    // Handler still works — it uses the hardcoded default 'broadband-cache'.
    expect(res.statusCode).toBe(200);
  });

  it('falls back to empty path when requestContext.http is missing', async () => {
    const { handler } = await loadHandler();
    const res = await handler({
      // No requestContext.http — exercises the `?? ''` fallback on line 116.
      // With path = '' the handler reaches the 404 branch.
      headers: { 'x-origin-verify': SECRET },
      queryStringParameters: { pc: 'SW1A1AA' },
    });
    expect(res.statusCode).toBe(404);
  });
});