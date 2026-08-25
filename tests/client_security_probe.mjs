import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const vercel = JSON.parse(source('../client/vercel.json'));
const globalHeaders = vercel.headers.find((entry) => entry.source === '/(.*)')?.headers || [];
const headers = new Map(globalHeaders.map((header) => [header.key.toLowerCase(), header.value]));
const csp = headers.get('content-security-policy') || '';
assert.match(csp, /default-src 'self'/);
assert.match(csp, /script-src 'self'/);
assert.match(csp, /connect-src 'self' https:\/\/api\.binance\.com wss:\/\/stream\.binance\.com:9443/);
assert.match(csp, /base-uri 'none'/);
assert.match(csp, /form-action 'none'/);
assert.match(csp, /frame-ancestors 'none'/);
assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin');
assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin');
assert.equal(headers.get('x-content-type-options'), 'nosniff');
assert.equal(headers.get('x-frame-options'), 'DENY');

const browserSources = [
  source('../client/app.mjs'),
  source('../client/identity.mjs'),
  source('../client/market.mjs'),
  source('../client/room-ui.mjs'),
  source('../client/technocore.mjs'),
].join('\n');
assert.doesNotMatch(
  browserSources,
  /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/,
);

const proxySource = source('../client/api/technocore.mjs');
assert.match(proxySource, /Cross-origin proxy request refused/);
assert.match(proxySource, /A valid signed Technocore message is required/);
assert.doesNotMatch(proxySource, /Access-Control-Allow-Origin/i);

console.log('client security probe: ok');
