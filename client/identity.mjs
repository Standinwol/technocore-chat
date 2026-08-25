export const SAVED_SEED_KEY = 'signal-id-ed25519-seed-v1';
export const VAULT_STORAGE_KEY = 'signal-id-identity-vault-v2';
const VAULT_ITERATIONS = 250_000;

const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

export function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
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

function emptyVault() {
  return { version: 2, activeDid: '', identities: [] };
}

export function loadIdentityVault(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(VAULT_STORAGE_KEY) || 'null');
    if (parsed?.version !== 2 || !Array.isArray(parsed.identities)) return emptyVault();
    const identities = parsed.identities.filter((record) => record
      && typeof record.did === 'string'
      && typeof record.ciphertext === 'string'
      && typeof record.salt === 'string'
      && typeof record.iv === 'string');
    return {
      version: 2,
      activeDid: identities.some((record) => record.did === parsed.activeDid)
        ? parsed.activeDid
        : identities[0]?.did || '',
      identities,
    };
  } catch (_) {
    return emptyVault();
  }
}

function writeIdentityVault(storage, vault) {
  storage?.setItem(VAULT_STORAGE_KEY, JSON.stringify(vault));
  return vault;
}

function vaultPassphrase(value) {
  const passphrase = String(value || '');
  if (passphrase.length < 8) throw new Error('Vault passphrase must contain at least 8 characters.');
  return passphrase;
}

async function deriveVaultKey(passphrase, salt, iterations, cryptoApi) {
  const material = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(vaultPassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return cryptoApi.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function saveIdentityToVault(
  storage,
  identity,
  passphrase,
  label = '',
  cryptoApi = globalThis.crypto,
  iterations = VAULT_ITERATIONS,
) {
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Web Crypto is unavailable.');
  }
  if (!identity?.did || !/^[0-9a-f]{64}$/.test(identity.seed || '')) {
    throw new Error('An active Ed25519 identity is required.');
  }
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt, iterations, cryptoApi);
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(identity.did),
    },
    key,
    unhex(identity.seed),
  );
  const now = new Date().toISOString();
  const vault = loadIdentityVault(storage);
  const previous = vault.identities.find((record) => record.did === identity.did);
  const record = {
    version: 1,
    did: identity.did,
    label: String(label || '').trim().slice(0, 48) || 'Browser DID',
    ciphertext: encodeBase64url(new Uint8Array(ciphertext)),
    salt: encodeBase64url(salt),
    iv: encodeBase64url(iv),
    iterations,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  const identities = vault.identities.filter((value) => value.did !== identity.did);
  identities.push(record);
  writeIdentityVault(storage, { version: 2, activeDid: identity.did, identities });
  return record;
}

export async function unlockIdentityFromVault(
  storage,
  did,
  passphrase,
  cryptoApi = globalThis.crypto,
) {
  const vault = loadIdentityVault(storage);
  const record = vault.identities.find((value) => value.did === did);
  if (!record) throw new Error('Choose a saved DID to unlock.');
  try {
    const salt = decodeBase64url(record.salt);
    const iv = decodeBase64url(record.iv);
    const key = await deriveVaultKey(
      passphrase,
      salt,
      Number(record.iterations) || VAULT_ITERATIONS,
      cryptoApi,
    );
    const seed = await cryptoApi.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(record.did),
      },
      key,
      decodeBase64url(record.ciphertext),
    );
    const seedHex = hex(new Uint8Array(seed));
    const identity = await createIdentity(seedHex, cryptoApi);
    if (identity.did !== record.did) throw new Error('DID mismatch');
    writeIdentityVault(storage, { ...vault, activeDid: record.did });
    return identity;
  } catch (_) {
    throw new Error('The vault passphrase is wrong or this saved identity is corrupted.');
  }
}

export function removeIdentityFromVault(storage, did) {
  const vault = loadIdentityVault(storage);
  const identities = vault.identities.filter((record) => record.did !== did);
  const activeDid = vault.activeDid === did ? identities[0]?.did || '' : vault.activeDid;
  return writeIdentityVault(storage, { version: 2, activeDid, identities });
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
