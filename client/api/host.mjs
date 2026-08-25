const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function sameOriginBrowserRequest(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

export function hostIdentityResponse(
  request,
  environment = globalThis.process?.env || {},
) {
  if (!sameOriginBrowserRequest(request)) {
    return Response.json({ error: 'Cross-origin request refused.' }, {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed.' }, {
      status: 405,
      headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
    });
  }
  const did = String(environment.HOST_DID || '').trim();
  const configured = DID_RE.test(did);
  return Response.json({
    configured,
    did: configured ? did : null,
    name: String(environment.HOST_NAME || 'Signal ID Host').trim().slice(0, 64),
  }, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default {
  fetch(request) {
    return hostIdentityResponse(request);
  },
};
