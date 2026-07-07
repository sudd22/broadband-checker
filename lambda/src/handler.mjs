import { createHash } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ssmClient = new SSMClient({});

let cachedApiKey;

const TABLE = process.env.DYNAMODB_TABLE ?? 'broadband-cache';
const PARAM = process.env.SSM_PARAM_PATH ?? '/broadband/ofcom-key';
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const ORIGIN_SECRET = process.env.ORIGIN_VERIFY_SECRET;
const POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-BD-HJLNP-UW-Z]{2}$/;

export function normalise(raw) {
  return (raw ?? '').replace(/\s+/g, '').toUpperCase().trim();
}

export function hashPostcode(clean) {
  return createHash('sha256').update(clean).digest('hex').slice(0, 8);
}

export function getHeader(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

export function respond(statusCode, body, cacheControl = 'max-age=300') {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    body: JSON.stringify(body),
  };
}

export function log(level, data) {
  console.log(JSON.stringify({ level, ts: new Date().toISOString(), ...data }));
}

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

export const handler = async (event) => {
  const path = event.requestContext?.http?.path ?? '';

  if (ORIGIN_SECRET) {
    const provided = getHeader(event.headers, 'X-Origin-Verify');
    if (!provided || provided !== ORIGIN_SECRET) {
      return respond(403, {
        error: 'FORBIDDEN',
        message: 'Direct access is not permitted',
      }, 'no-store');
    }
  }

  if (path === '/api/health' || path === '/health') {
    return respond(200, { status: 'ok', ts: new Date().toISOString() }, 'no-store');
  }

  if (path !== '/api/check' && path !== '/check') {
    return respond(404, { error: 'NOT_FOUND', message: 'Route not found' }, 'no-store');
  }

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

  try {
    const { Item } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { postcode: pc },
    }));

    if (Item && Item.ttl > Math.floor(Date.now() / 1000)) {
      const responseTime = Date.now() - t0;
      log('INFO', { pc_hash: pcHash, source: 'cache', durationMs: responseTime });
      return respond(200, { ...Item.data, source: 'cache', responseTime });
    }

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