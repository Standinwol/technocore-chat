import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { hostIdentityResponse } from '../client/api/host.mjs';
import {
  VAULT_STORAGE_KEY,
  createIdentity,
  loadIdentityVault,
  removeIdentityFromVault,
  saveIdentityToVault,
  unlockIdentityFromVault,
} from '../client/identity.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const storage = memoryStorage();
const firstSeed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const secondSeed = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const first = await createIdentity(firstSeed, webcrypto);
const second = await createIdentity(secondSeed, webcrypto);

const record = await saveIdentityToVault(
  storage, first, 'correct horse battery staple', 'Primary DID', webcrypto, 1_000,
);
assert.equal(record.did, first.did);
assert.equal(record.label, 'Primary DID');
assert.equal(record.iterations, 1_000);
assert.doesNotMatch(storage.getItem(VAULT_STORAGE_KEY), new RegExp(firstSeed));

const unlocked = await unlockIdentityFromVault(
  storage, first.did, 'correct horse battery staple', webcrypto,
);
assert.equal(unlocked.did, first.did);
assert.equal(unlocked.seed, firstSeed);
await assert.rejects(
  unlockIdentityFromVault(storage, first.did, 'wrong passphrase', webcrypto),
  /wrong or this saved identity is corrupted/,
);

await saveIdentityToVault(
  storage, second, 'another strong passphrase', 'Trading DID', webcrypto, 1_000,
);
let vault = loadIdentityVault(storage);
assert.equal(vault.identities.length, 2);
assert.equal(vault.activeDid, second.did);
assert.deepEqual(vault.identities.map((value) => value.label), ['Primary DID', 'Trading DID']);

removeIdentityFromVault(storage, first.did);
vault = loadIdentityVault(storage);
assert.deepEqual(vault.identities.map((value) => value.did), [second.did]);

const configured = await hostIdentityResponse(
  new Request('https://client.example/api/host'),
  { HOST_DID: first.did, HOST_NAME: 'Price Host' },
).json();
assert.deepEqual(configured, { configured: true, did: first.did, name: 'Price Host' });

const unconfigured = await hostIdentityResponse(
  new Request('https://client.example/api/host'),
  { HOST_DID: 'did:key:not-valid' },
).json();
assert.equal(unconfigured.configured, false);
assert.equal(unconfigured.did, null);

const refused = hostIdentityResponse(
  new Request('https://client.example/api/host', { method: 'POST' }),
  { HOST_DID: first.did },
);
assert.equal(refused.status, 405);
assert.equal(refused.headers.get('allow'), 'GET');

const crossOrigin = hostIdentityResponse(
  new Request('https://client.example/api/host', {
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  }),
  { HOST_DID: first.did },
);
assert.equal(crossOrigin.status, 403);

console.log('client vault probe: ok');
