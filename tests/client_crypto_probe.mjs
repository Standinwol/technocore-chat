import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  answerCryptoQuery,
  buildSignedMessageUrl,
  buildPeriodicReport,
  canonicalSnapshot,
  cleanTechnocoreText,
  createIdentity,
  formatPrice,
  normalizeSymbol,
  signSnapshot,
  signTechnocoreMessage,
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
assert.equal(answerCryptoQuery('BTC price', agentTickers).intent, 'price');
assert.match(answerCryptoQuery('BTC price', agentTickers).text, /BTC: \$100\.0000 · \+2\.50%/);
assert.match(answerCryptoQuery('price BTCUSDT', agentTickers).text, /BTC: \$100\.0000/);
assert.equal(answerCryptoQuery('Compare BTC and ETH', agentTickers).intent, 'compare');
assert.match(answerCryptoQuery('Compare BTC and ETH', agentTickers).text, /BTC has the best 24h performance/);
assert.equal(answerCryptoQuery('Which coins are falling?', agentTickers).intent, 'losers');
assert.match(answerCryptoQuery('Which coins are falling?', agentTickers).text, /ETH/);
assert.doesNotMatch(answerCryptoQuery('Which coins are falling?', agentTickers).text, /SOL:/);
assert.equal(answerCryptoQuery('which coin is falling?', agentTickers).intent, 'losers');
assert.equal(answerCryptoQuery('Top gainers', agentTickers).intent, 'gainers');
assert.match(answerCryptoQuery('Top gainers', agentTickers).text, /SOL:[\s\S]*BTC:/);
assert.doesNotMatch(answerCryptoQuery('Top gainers', agentTickers).text, /ETH:/);
assert.equal(answerCryptoQuery('24h range for ETH', agentTickers).intent, 'range');
assert.match(answerCryptoQuery('24h range for ETH', agentTickers).text, /range 22\.22%/);
const report = buildPeriodicReport(agentTickers, 1700000005000);
assert.match(report, /Automated report/);
assert.match(report, /Best performer: SOL/);
assert.match(report, /Weakest performer: ETH/);
assert.match(report, /2 up\/flat · 1 down/);

const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../client/app.mjs', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML ids must be unique');
for (const id of ['agent-log', 'agent-form', 'agent-question', 'report-interval', 'ticker-list',
  'technocore-message', 'sign-technocore', 'signed-url', 'download-seed']) {
  assert.ok(ids.includes(id), `missing #${id}`);
}
for (const match of appSource.matchAll(/getElementById\('([^']+)'\)/g)) {
  assert.ok(ids.includes(match[1]), `app references missing #${match[1]}`);
}

const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identity = await createIdentity(seed, webcrypto);
assert.match(identity.did, /^did:key:z6Mk/);
assert.equal(identity.did.length, 56);
assert.equal(identity.seed, seed);

assert.equal(cleanTechnocoreText('  hello\nTechnocore\u200b  '), 'hello Technocore');
const signedMessage = await signTechnocoreMessage(
  identity, 'Technocore', '1700000005001', '  hello\nTechnocore\u200b  ', webcrypto,
);
assert.equal(signedMessage.room, 'technocore');
assert.equal(signedMessage.text, 'hello Technocore');
assert.equal(signedMessage.canonical, 'technocore|1700000005001|hello Technocore');
assert.match(signedMessage.sig, /^[A-Za-z0-9_-]{86}$/);
assert.equal(await webcrypto.subtle.verify(
  'Ed25519',
  identity.verifyKey,
  Buffer.from(signedMessage.sig, 'base64url'),
  new TextEncoder().encode(signedMessage.canonical),
), true);
const signedUrl = buildSignedMessageUrl('https://technocore.chat/docs', signedMessage);
assert.match(signedUrl, /^https:\/\/technocore\.chat\/r\/technocore\/say-signed\/did%3Akey%3Az6Mk/);
assert.match(signedUrl, /\/1700000005001\/hello%20Technocore$/);
assert.throws(() => buildSignedMessageUrl('http://example.com', signedMessage), /must use HTTPS/);
await assert.rejects(
  signTechnocoreMessage(identity, 'bad room', '1', 'hello', webcrypto),
  /Room names/,
);

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
