const DEFAULT_UPSTREAM = 'https://technocore.chat';
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const NONCE_RE = /^[0-9]{1,19}$/;
const MAX_BODY = 64 << 10;

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }) + '\n', {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
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

    if (request.method === 'POST' && operation === 'post') {
      const room = roomName(url.searchParams.get('room'));
      if (!room) return jsonError('Invalid Technocore room name.', 400);
      const declared = Number(request.headers.get('content-length')) || 0;
      if (declared > MAX_BODY) return jsonError('Request body is too large.', 413);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY) {
        return jsonError('Request body is too large.', 413);
      }
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch (_) {
        return jsonError('Request body must be JSON.', 400);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return jsonError('Request body must be a JSON object.', 400);
      }
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
    return jsonError(`Technocore upstream failed: ${error.message}`, 502);
  }
  return jsonError('Unknown Technocore proxy operation.', 404);
}

export default {
  fetch(request) {
    return handleTechnocoreProxy(request);
  },
};
