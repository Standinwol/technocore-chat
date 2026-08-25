import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  canonicalSnapshot,
  createIdentity,
  formatPrice,
  normalizeSymbol,
  signSnapshot,
  tickerFromRest,
  tickerFromStream,
} from '../client/app.mjs';

assert.equal(normalizeSymbol('btc'), 'BTCUSDT');
assert.equal(normalizeSymbol('eth/usdt'), 'ETHUSDT');
assert.equal(normalizeSymbol('SOL-USDT'), 'SOLUSDT');
assert.throws(() => normalizeSymbol(''), /Enter an asset/);
assert.throws(() => normalizeSymbol('$$$'), /valid USDT market/);

assert.equal(formatPrice('79186.54'), '$79,186.54');
assert.equal(formatPrice('0.00001234'), '$0.00001234');
assert.equal(formatPrice('not-a-number'), '—');

const restTicker = tickerFromRest({
  symbol: 'BTCUSDT', lastPrice: '100.25', priceChangePercent: '2.5', highPrice: '103',
  lowPrice: '95', quoteVolume: '12345', closeTime: '1700000000000',
});
assert.deepEqual(restTicker, {
  symbol: 'BTCUSDT', price: 100.25, change: 2.5, high: 103, low: 95,
  volume: 12345, timestamp: 1700000000000,
});

const streamTicker = tickerFromStream({
  s: 'ETHUSDT', c: '10', P: '-1.25', h: '11', l: '9', q: '999', E: 1700000001000,
});
assert.deepEqual(streamTicker, {
  symbol: 'ETHUSDT', price: 10, change: -1.25, high: 11, low: 9,
  volume: 999, timestamp: 1700000001000,
});

const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identity = await createIdentity(seed, webcrypto);
assert.match(identity.did, /^did:key:z6Mk/);
assert.equal(identity.did.length, 56);
assert.equal(identity.seed, seed);

const observedAt = 1700000000000;
const createdAt = 1700000005000;
const tickers = [
  { symbol: 'ETHUSDT', price: 10, change: -1.25, timestamp: observedAt + 1000 },
  { symbol: 'BTCUSDT', price: 100.25, change: 2.5, timestamp: observedAt },
];
const canonical = canonicalSnapshot(identity.did, tickers, createdAt);
const payload = JSON.parse(canonical);
assert.deepEqual(payload.quotes.map((quote) => quote.symbol), ['BTCUSDT', 'ETHUSDT']);
assert.equal(payload.source, 'Binance Spot API');

const envelope = JSON.parse(await signSnapshot(identity, tickers, createdAt, webcrypto));
assert.deepEqual(envelope.payload, payload);
assert.match(envelope.signature, /^[0-9a-f]{128}$/);
const verified = await webcrypto.subtle.verify(
  'Ed25519',
  identity.verifyKey,
  Buffer.from(envelope.signature, 'hex'),
  new TextEncoder().encode(canonical),
);
assert.equal(verified, true);

console.log('client crypto probe: ok');
