export const SAVED_SEED_KEY = 'signal-id-ed25519-seed-v1';

const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

export function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function parseIdentityBackup(value) {
  const text = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { seed: text.toLowerCase(), did: '' };
  }
  const lines = text.split(/\r?\n/);
  const seedLines = lines.filter((line) => /^seed\s*:/i.test(line));
  const seedMatch = seedLines.length === 1
    ? /^seed:\s*([0-9a-fA-F]{64})\s*$/i.exec(seedLines[0])
    : null;
  if (!seedMatch) {
    throw new Error('The seed file must contain exactly one valid 64-character hex seed.');
  }
  const didLines = lines.filter((line) => /^did\s*:/i.test(line));
  if (didLines.length > 1) {
    throw new Error('The seed file contains more than one DID.');
  }
  const didMatch = didLines.length
    ? /^did:\s*(did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44})\s*$/.exec(didLines[0])
    : null;
  if (didLines.length && !didMatch) throw new Error('The seed file contains an invalid DID.');
  return {
    seed: seedMatch[1].toLowerCase(),
    did: didMatch?.[1] || '',
  };
}

function unhex(value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('The private seed must be exactly 64 hexadecimal characters.');
  }
  return new Uint8Array(value.match(/../g).map((pair) => parseInt(pair, 16)));
}

export function decodeBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  if (typeof atob === 'function') {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

export function encodeBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let result = '';
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result || '1';
}

export async function createIdentity(seedHex, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) {
    throw new Error('Web Crypto is unavailable. Open this app over HTTPS or localhost.');
  }
  const seed = unhex(seedHex);
  const encoded = new Uint8Array(PKCS8_ED25519.length + seed.length);
  encoded.set(PKCS8_ED25519);
  encoded.set(seed, PKCS8_ED25519.length);
  const key = await cryptoApi.subtle.importKey(
    'pkcs8', encoded, { name: 'Ed25519' }, true, ['sign'],
  );
  const jwk = await cryptoApi.subtle.exportKey('jwk', key);
  const publicBytes = decodeBase64url(jwk.x);
  const tagged = new Uint8Array(publicBytes.length + 2);
  tagged.set([0xed, 0x01]);
  tagged.set(publicBytes, 2);
  const verifyKey = await cryptoApi.subtle.importKey(
    'raw', publicBytes, { name: 'Ed25519' }, true, ['verify'],
  );
  return {
    did: 'did:key:z' + base58(tagged),
    seed: hex(seed),
    key,
    verifyKey,
  };
}

export function saveIdentitySeed(storage, seed, fallbackStorage = null) {
  const normalized = String(seed || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Refusing to store an invalid Ed25519 seed.');
  }
  try {
    storage.setItem(SAVED_SEED_KEY, normalized);
    fallbackStorage?.removeItem(SAVED_SEED_KEY);
    return 'persistent';
  } catch (error) {
    if (!fallbackStorage) throw error;
    fallbackStorage.setItem(SAVED_SEED_KEY, normalized);
    return 'session';
  }
}

export function loadIdentitySeed(storage, fallbackStorage = null) {
  for (const candidate of [storage, fallbackStorage]) {
    if (!candidate) continue;
    try {
      const seed = String(candidate.getItem(SAVED_SEED_KEY) || '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(seed)) return seed;
      if (seed) candidate.removeItem(SAVED_SEED_KEY);
    } catch (_) {
      // Private browsing policies can disable a storage provider entirely.
    }
  }
  return null;
}

export function clearIdentitySeed(storage, fallbackStorage = null) {
  for (const candidate of [storage, fallbackStorage]) {
    try {
      candidate?.removeItem(SAVED_SEED_KEY);
    } catch (_) {
      // Removing an unavailable storage provider is already the desired state.
    }
  }
}

export function canonicalSnapshot(did, tickers, createdAt) {
  const quotes = [...tickers]
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((ticker) => ({
      symbol: ticker.symbol,
      price: String(ticker.price),
      change24h: String(ticker.change),
      observedAt: new Date(ticker.timestamp).toISOString(),
    }));
  return JSON.stringify({
    type: 'CryptoPriceSnapshot',
    version: 1,
    did,
    createdAt: new Date(createdAt).toISOString(),
    source: 'Binance Spot API',
    quotes,
  });
}

export async function signSnapshot(
  identity, tickers, createdAt = Date.now(), cryptoApi = globalThis.crypto,
) {
  const payload = canonicalSnapshot(identity.did, tickers, createdAt);
  const signature = await cryptoApi.subtle.sign(
    'Ed25519', identity.key, new TextEncoder().encode(payload),
  );
  return JSON.stringify(
    { payload: JSON.parse(payload), signature: hex(new Uint8Array(signature)) }, null, 2,
  );
}
