const DEFAULT_UPSTREAM = 'https://technocore.chat';
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const NONCE_RE = /^[0-9]{1,19}$/;
const TCLK_CONTRACT_RE = /^0x[0-9a-f]{64}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const MAX_PAPER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 64 << 10;

class ProxyProblem extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value) + '\n', {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function jsonError(message, status) {
  return jsonResponse({ error: message }, status);
}

function integer(value, fallback, minimum, maximum) {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function roomName(value) {
  const room = String(value || '').trim().toLowerCase();
  return ROOM_RE.test(room) ? room : null;
}

function sameOriginBrowserRequest(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

function upstreamOrigin(configured) {
  const url = new URL(configured || DEFAULT_UPSTREAM);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('TECHNOCORE_URL must use HTTPS.');
  }
  return url.origin;
}

async function forward(upstream, init, fetchApi) {
  const response = await fetchApi(upstream, { cache: 'no-store', ...init });
  const body = await response.arrayBuffer();
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new Response(body, { status: response.status, headers });
}

async function jsonObject(request) {
  const declared = Number(request.headers.get('content-length')) || 0;
  if (declared > MAX_BODY) throw new ProxyProblem('Request body is too large.', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) {
    throw new ProxyProblem('Request body is too large.', 413);
  }
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (_) {
    throw new ProxyProblem('Request body must be JSON.', 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProxyProblem('Request body must be a JSON object.', 400);
  }
  return payload;
}

function paperLocation(contract) {
  return {
    namespace: `tclk-paper-${contract.slice(2, 4)}`,
    key: contract.slice(4, 18),
  };
}

function paperLine(text) {
  return String(text).split('\n').find((line) => line.startsWith('tclkpaper1 ')) || null;
}

async function readPaper(upstream, contract, fetchApi) {
  const { namespace, key } = paperLocation(contract);
  const response = await fetchApi(
    `${upstream}/kv/${namespace}/${key}`,
    { cache: 'no-store', headers: { Accept: 'text/plain' } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 240);
    throw new ProxyProblem(detail || `Technocore returned HTTP ${response.status}.`, response.status);
  }
  return paperLine(await response.text());
}

async function setPaper(upstream, contract, value, condition, fetchApi) {
  const { namespace, key } = paperLocation(contract);
  const response = await fetchApi(`${upstream}/kv/${namespace}/${key}`, {
    cache: 'no-store',
    method: 'POST',
    headers: { Accept: 'text/plain', 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, ...condition }),
  });
  if (response.ok) return true;
  if (response.status === 409) return false;
  const detail = (await response.text()).trim().slice(0, 240);
  throw new ProxyProblem(detail || `Technocore returned HTTP ${response.status}.`, response.status);
}

function parseHashPaper(value) {
  const match = /^tclkpaper1 (locked|claimed) hash (0x[0-9a-f]{64}) ([1-9][0-9]*)(?: (0x[0-9a-f]{64}))?$/.exec(value || '');
  if (!match || (match[1] === 'claimed') !== Boolean(match[4])) return null;
  const refundAfterMs = Number(match[3]);
  if (!Number.isSafeInteger(refundAfterMs)) return null;
  return {
    status: match[1],
    statement: match[2],
    refundAfterMs,
    ...(match[4] ? { secret: match[4] } : {}),
  };
}

async function hashPreimage(secret) {
  const bytes = new Uint8Array(secret.slice(2).match(/../g).map((byte) => Number.parseInt(byte, 16)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function handleTechnocoreProxy(
  request,
  fetchApi = globalThis.fetch,
  configuredUpstream = globalThis.process?.env?.TECHNOCORE_URL || DEFAULT_UPSTREAM,
) {
  if (typeof fetchApi !== 'function') return jsonError('Server fetch is unavailable.', 500);
  if (!sameOriginBrowserRequest(request)) return jsonError('Cross-origin proxy request refused.', 403);
  let upstream;
  try {
    upstream = upstreamOrigin(configuredUpstream);
  } catch (error) {
    return jsonError(error.message, 500);
  }

  const url = new URL(request.url);
  const operation = url.searchParams.get('op');
  try {
    if (request.method === 'GET' && operation === 'rooms') {
      const limit = integer(url.searchParams.get('limit'), 50, 0, 200);
      return await forward(
        `${upstream}/rooms?format=json&limit=${limit}`,
        { headers: { Accept: 'application/json' } },
        fetchApi,
      );
    }

    if (request.method === 'GET' && operation === 'room') {
      const room = roomName(url.searchParams.get('room'));
      if (!room) return jsonError('Invalid Technocore room name.', 400);
      const limit = integer(url.searchParams.get('limit'), 50, 1, 200);
      const since = integer(url.searchParams.get('since'), null, 0, Number.MAX_SAFE_INTEGER);
      const wait = Math.min(10, Math.max(0, Number(url.searchParams.get('wait')) || 0));
      const query = new URLSearchParams({ format: 'json', limit: String(limit) });
      if (since !== null) query.set('since', String(since));
      if (wait) query.set('wait', String(wait));
      return await forward(
        `${upstream}/r/${encodeURIComponent(room)}?${query}`,
        { headers: { Accept: 'application/json' } },
        fetchApi,
      );
    }

    if (request.method === 'GET' && operation === 'paper') {
      const contract = String(url.searchParams.get('contract') || '').trim().toLowerCase();
      if (!TCLK_CONTRACT_RE.test(contract)) {
        return jsonError('Invalid tclk contract id.', 400);
      }
      return jsonResponse({ contract, value: await readPaper(upstream, contract, fetchApi) });
    }

    if (request.method === 'POST' && operation === 'paper-lock') {
      const payload = await jsonObject(request);
      const contract = String(payload.contract || '').trim().toLowerCase();
      const statement = String(payload.statement || '').trim().toLowerCase();
      const refundAfterMs = Number(payload.refundAfterMs);
      const now = Date.now();
      if (!TCLK_CONTRACT_RE.test(contract)
          || !HASH_RE.test(statement)
          || !Number.isSafeInteger(refundAfterMs)
          || refundAfterMs <= now
          || refundAfterMs > now + MAX_PAPER_WINDOW_MS) {
        return jsonError('A valid, near-term tclk PAPER lock is required.', 400);
      }
      const value = `tclkpaper1 locked hash ${statement} ${refundAfterMs}`;
      const current = await readPaper(upstream, contract, fetchApi);
      if (current === value) return jsonResponse({ contract, value, idempotent: true });
      if (current !== null) return jsonError('This PAPER contract already has a different record.', 409);
      const won = await setPaper(upstream, contract, value, { if_absent: true }, fetchApi);
      if (won) return jsonResponse({ contract, value, idempotent: false });
      const raced = await readPaper(upstream, contract, fetchApi);
      if (raced === value) return jsonResponse({ contract, value, idempotent: true });
      return jsonError('This PAPER contract changed before it could be locked.', 409);
    }

    if (request.method === 'POST' && operation === 'paper-claim') {
      const payload = await jsonObject(request);
      const contract = String(payload.contract || '').trim().toLowerCase();
      const secret = String(payload.secret || '').trim().toLowerCase();
      if (!TCLK_CONTRACT_RE.test(contract) || !HASH_RE.test(secret)) {
        return jsonError('A valid tclk PAPER contract and hash preimage are required.', 400);
      }
      const current = await readPaper(upstream, contract, fetchApi);
      const record = parseHashPaper(current);
      if (!record) return jsonError('The PAPER lock is missing or unreadable.', 409);
      const value = `tclkpaper1 claimed hash ${record.statement} ${record.refundAfterMs} ${secret}`;
      if (record.status === 'claimed') {
        return current === value
          ? jsonResponse({ contract, value, idempotent: true })
          : jsonError('This PAPER contract was already claimed differently.', 409);
      }
      if (Date.now() >= record.refundAfterMs) {
        return jsonError('The PAPER refund window is already open.', 409);
      }
      if (await hashPreimage(secret) !== record.statement) {
        return jsonError('The preimage does not open this PAPER hash lock.', 400);
      }
      const won = await setPaper(upstream, contract, value, { if: current }, fetchApi);
      if (won) return jsonResponse({ contract, value, idempotent: false });
      const raced = await readPaper(upstream, contract, fetchApi);
      if (raced === value) return jsonResponse({ contract, value, idempotent: true });
      return jsonError('This PAPER contract changed before it could be claimed.', 409);
    }

    if (request.method === 'POST' && operation === 'post') {
      const room = roomName(url.searchParams.get('room'));
      if (!room) return jsonError('Invalid Technocore room name.', 400);
      const payload = await jsonObject(request);
      if (!DID_RE.test(String(payload.did || ''))
          || !SIG_RE.test(String(payload.sig || ''))
          || !NONCE_RE.test(String(payload.nonce || ''))
          || typeof payload.text !== 'string'
          || !payload.text.trim()
          || payload.text.length > 4096) {
        return jsonError('A valid signed Technocore message is required.', 400);
      }
      const body = JSON.stringify({
        did: payload.did,
        sig: payload.sig,
        nonce: payload.nonce,
        text: payload.text,
      });
      return await forward(
        `${upstream}/r/${encodeURIComponent(room)}?format=json`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body,
        },
        fetchApi,
      );
    }
  } catch (error) {
    if (error instanceof ProxyProblem) return jsonError(error.message, error.status);
    return jsonError(`Technocore upstream failed: ${error.message}`, 502);
  }
  return jsonError('Unknown Technocore proxy operation.', 404);
}

export default {
  fetch(request) {
    return handleTechnocoreProxy(request);
  },
};
