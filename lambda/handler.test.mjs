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
// Shared mocks. The handler captures ssmClient.send + docClient.send at
// module load, so we re-import handler.mjs in each test (via loadHandler)
// for a fresh container. The refs are reused but reset in beforeEach.
// -----------------------------------------------------------------------------
const ssmSend = vi.fn();
const docSend = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(() => ({ send: ssmSend })),
  GetParameterCommand: vi.fn((input) => ({ __cmd: 'GetParameter', input })),
}));

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
const SSM_NAME = '/broadband/ofcom-key';
const API_KEY = 'ofcom-live-key-123';
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

/** Fresh import so module-level env-var capture resets per test (cold start). */
async function loadHandler() {
  vi.resetModules();
  return import('./src/handler.mjs');
}

beforeEach(() => {
  ssmSend.mockReset();
  docSend.mockReset();
  process.env.ORIGIN_VERIFY_SECRET = SECRET;
  process.env.DYNAMODB_TABLE = TABLE;
  process.env.SSM_PARAM_PATH = SSM_NAME;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
});

// =============================================================================
// SSM — getApiKey
// =============================================================================
describe('getApiKey (SSM memoisation)', () => {
  it('calls SSM once with WithDecryption=true and returns the value', async () => {
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    const { getApiKey } = await loadHandler();
    const key = await getApiKey();
    expect(key).toBe(API_KEY);
    const { GetParameterCommand } = await import('@aws-sdk/client-ssm');
    expect(GetParameterCommand).toHaveBeenCalledWith({
      Name: SSM_NAME,
      WithDecryption: true,
    });
  });

  it('only calls SSM once across multiple warm invocations', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: API_KEY } });
    const { getApiKey } = await loadHandler();
    await getApiKey();
    await getApiKey();
    await getApiKey();
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });

  it('throws when SSM returns no parameter value', async () => {
    ssmSend.mockResolvedValueOnce({});
    const { getApiKey } = await loadHandler();
    await expect(getApiKey()).rejects.toThrow(/not present/i);
  });
});

// =============================================================================
// Ofcom — fetchFromOfcom
// =============================================================================
describe('fetchFromOfcom', () => {
  it('calls Ofcom with x-api-key auth + the cleaned postcode and parses JSON', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ standard: { maxDown: 100, maxUp: 10, availability: 99 } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { fetchFromOfcom } = await loadHandler();
    const result = await fetchFromOfcom(CLEAN_PC, API_KEY);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`https://api.ofcom.org.uk/broadband-coverage?postcode=${CLEAN_PC}`);
    expect(opts.headers['x-api-key']).toBe(API_KEY);
    expect(opts.signal).toBeDefined();
    expect(result.standard.maxDown).toBe(100);
  });

  it('throws with the HTTP status when Ofcom responds non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { fetchFromOfcom } = await loadHandler();
    await expect(fetchFromOfcom(CLEAN_PC, API_KEY)).rejects.toThrow(/503/);
  });
});

// =============================================================================
// mapOfcom — adapter (exported indirectly via handler; tested by exercising
// the cache-miss path with a mocked Ofcom response shape)
// =============================================================================
describe('mapOfcom (via handler cache-miss path)', () => {
  it('buckets availability into full/partial/none across the three tiers', async () => {
    // >95 → full, 5-95 → partial, <5 → none
    const ofcomRaw = {
      standard:  { maxDown: 17,  maxUp: 2,  availability: 99 }, // full
      superfast: { maxDown: 80,  maxUp: 20, availability: 50 }, // partial
      ultrafast: { maxDown: 330, maxUp: 50, availability: 2  }, // none
    };
    docSend.mockResolvedValueOnce({}); // DDB miss
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ofcomRaw,
    }));
    docSend.mockResolvedValueOnce({}); // Put

    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);

    expect(body.source).toBe('live');
    expect(body.standard.availability).toBe('full');
    expect(body.superfast.availability).toBe('partial');
    expect(body.ultrafast.availability).toBe('none');
    expect(body.standard.maxDown).toBe(17);
    expect(body.superfast.maxUp).toBe(20);
    expect(body.ultrafast.maxDown).toBe(330);
  });

  it('defaults missing tier fields to 0 / "none" availability', async () => {
    docSend.mockResolvedValueOnce({}); // DDB miss
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({}), // Ofcom returns nothing
    }));
    docSend.mockResolvedValueOnce({}); // Put

    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);

    expect(body.standard.maxDown).toBe(0);
    expect(body.standard.availability).toBe('none');
    expect(body.superfast.maxDown).toBe(0);
    expect(body.ultrafast.maxDown).toBe(0);
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
    expect(ssmSend).not.toHaveBeenCalled();
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

  it('allows the request through when ORIGIN_VERIFY_SECRET is not configured', async () => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    docSend.mockResolvedValue({});
    ssmSend.mockResolvedValue({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({}),
    }));
    const { handler } = await loadHandler();
    const res = await handler(makeEvent({ headers: {} }));
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
  it('returns 200 ok for GET /api/health', async () => {
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
    docSend.mockResolvedValue({});
    ssmSend.mockResolvedValue({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
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
  it('returns cached item with source=cache (no SSM / fetch)', async () => {
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
    expect(ssmSend).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({});
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

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
// Cache miss → SSM → Ofcom → write-back
// =============================================================================
describe('cache miss → SSM → Ofcom → write-back', () => {
  it('returns source=live with the mapped Ofcom response and writes 24h TTL', async () => {
    const ofcomRaw = {
      standard:  { maxDown: 80, maxUp: 20, availability: 99 },
      superfast: { maxDown: 80, maxUp: 20, availability: 99 },
      ultrafast: { maxDown: 0,  maxUp: 0,  availability: 2  },
    };
    docSend
      .mockResolvedValueOnce({})               // GetCommand miss
      .mockResolvedValueOnce({});              // PutCommand
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ofcomRaw,
    }));

    const before = Math.floor(Date.now() / 1000);
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    const after = Math.floor(Date.now() / 1000);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('live');
    expect(body.postcode).toBe(CLEAN_PC);
    expect(body.standard.availability).toBe('full');
    expect(body.ultrafast.availability).toBe('none');
    expect(body.responseTime).toBeGreaterThanOrEqual(0);

    // Write-back uses the normalised postcode as the DDB key.
    // What is CACHED = the raw mapped payload (no source/responseTime — those
    // are added per response, not stored).
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { mapOfcom } = await loadHandler();
    const putArg = PutCommand.mock.calls.at(-1)[0];
    expect(putArg.TableName).toBe(TABLE);
    expect(putArg.Item.postcode).toBe(CLEAN_PC);
    expect(putArg.Item.data).toEqual(mapOfcom(CLEAN_PC, ofcomRaw));
    expect(putArg.Item.ttl).toBeGreaterThanOrEqual(before + 24 * 60 * 60);
    expect(putArg.Item.ttl).toBeLessThanOrEqual(after + 24 * 60 * 60);
  });

  it('uses the normalised postcode (not pcHash) as the DynamoDB key', async () => {
    docSend.mockResolvedValue({});
    ssmSend.mockResolvedValue({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const { handler } = await loadHandler();
    await handler(makeEvent({ postcode: '  Sw1a1Aa ' }));
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const getArg = GetCommand.mock.calls.at(-1)[0];
    expect(getArg.Key.postcode).toBe(CLEAN_PC);
    expect(getArg.Key.postcode).not.toBe(PC_HASH);
  });

  it('returns 502 when Ofcom responds with 5xx', async () => {
    docSend.mockResolvedValueOnce({}); // DDB miss
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('returns 502 when the SSM parameter has no value', async () => {
    docSend.mockResolvedValueOnce({}); // DDB miss
    ssmSend.mockResolvedValueOnce({}); // no Parameter returned at all
    const { handler } = await loadHandler();
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
  });

  it('logs the PutItem failure but still returns 200 with the live data', async () => {
    docSend
      .mockResolvedValueOnce({})              // GetCommand miss
      .mockRejectedValueOnce(new Error('put down')); // PutCommand fails
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
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

  it('different case/whitespace variants normalise to the same cache key', async () => {
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
    expect(res.statusCode).toBe(200);
  });

  it('falls back to default SSM param path when SSM_PARAM_PATH env var is unset', async () => {
    delete process.env.SSM_PARAM_PATH;
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: API_KEY } });
    const { getApiKey } = await loadHandler();
    const key = await getApiKey();
    expect(key).toBe(API_KEY);
    const { GetParameterCommand } = await import('@aws-sdk/client-ssm');
    // Default path '/broadband/ofcom-key' should be used
    expect(GetParameterCommand).toHaveBeenCalledWith({
      Name: '/broadband/ofcom-key',
      WithDecryption: true,
    });
  });

  it('falls back to empty path when requestContext.http is missing', async () => {
    const { handler } = await loadHandler();
    const res = await handler({
      // No requestContext.http — exercises the `?? ''` fallback
      headers: { 'x-origin-verify': SECRET },
      queryStringParameters: { pc: 'SW1A1AA' },
    });
    // With path = '' the handler reaches the 404 branch
    expect(res.statusCode).toBe(404);
  });
});