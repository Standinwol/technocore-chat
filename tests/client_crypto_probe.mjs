import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  answerCryptoQuery,
  buildPeriodicReport,
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

const agentTickers = [
  { symbol: 'BTCUSDT', price: 100, change: 2.5, high: 105, low: 95, timestamp: 1700000000000 },
  { symbol: 'ETHUSDT', price: 10, change: -1.25, high: 11, low: 9, timestamp: 1700000001000 },
  { symbol: 'SOLUSDT', price: 5, change: 4, high: 5.5, low: 4.5, timestamp: 1700000002000 },
];
assert.equal(answerCryptoQuery('Giá BTC', agentTickers).intent, 'price');
assert.match(answerCryptoQuery('Giá BTC', agentTickers).text, /BTC: \$100\.0000 · \+2\.50%/);
assert.match(answerCryptoQuery('price BTCUSDT', agentTickers).text, /BTC: \$100\.0000/);
assert.equal(answerCryptoQuery('So sánh BTC và ETH', agentTickers).intent, 'compare');
assert.match(answerCryptoQuery('So sánh BTC và ETH', agentTickers).text, /BTC đang có hiệu suất/);
assert.equal(answerCryptoQuery('Coin nào trong watchlist đang giảm?', agentTickers).intent, 'losers');
assert.match(answerCryptoQuery('Coin nào trong watchlist đang giảm?', agentTickers).text, /ETH/);
assert.doesNotMatch(answerCryptoQuery('Coin nào trong watchlist đang giảm?', agentTickers).text, /SOL:/);
assert.equal(answerCryptoQuery('which coin is falling?', agentTickers).intent, 'losers');
assert.equal(answerCryptoQuery('Top tăng', agentTickers).intent, 'gainers');
assert.match(answerCryptoQuery('Top tăng', agentTickers).text, /SOL:[\s\S]*BTC:/);
assert.doesNotMatch(answerCryptoQuery('Top tăng', agentTickers).text, /ETH:/);
assert.equal(answerCryptoQuery('Biến động 24 giờ của ETH', agentTickers).intent, 'range');
assert.match(answerCryptoQuery('Biến động 24 giờ của ETH', agentTickers).text, /biên độ 22\.22%/);
const report = buildPeriodicReport(agentTickers, 1700000005000);
assert.match(report, /Báo cáo tự động/);
assert.match(report, /Mạnh nhất: SOL/);
assert.match(report, /Yếu nhất: ETH/);
assert.match(report, /2 tăng\/đứng · 1 giảm/);

const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML ids must be unique');
for (const id of ['agent-log', 'agent-form', 'agent-question', 'report-interval', 'ticker-list']) {
  assert.ok(ids.includes(id), `missing #${id}`);
}

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
