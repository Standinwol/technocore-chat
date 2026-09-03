import { encodeBase64url } from './identity.mjs';

export const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const NONCE_STORAGE_KEY = 'signal-id-technocore-nonces-v1';
const TCLK_CONTRACT_RE = /^0x[0-9a-f]{64}$/;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;
const MAX_SAVED_NONCES = 128;

export class TechnocoreHttpError extends Error {
  constructor(message, status = 0, retryAfter = 0) {
    super(message);
    this.name = 'TechnocoreHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function normalizeRoom(room) {
  const normalized = String(room || '').trim().toLowerCase();
  if (!ROOM_RE.test(normalized)) {
    throw new Error(
      'Room names must use 1–48 lowercase letters, numbers, underscores, or hyphens.',
    );
  }
  return normalized;
}

export function cleanTechnocoreText(value) {
  return String(value || '').replace(INVISIBLE, ' ').trim();
}

export async function signTechnocoreMessage(
  identity, room, nonce, message, cryptoApi = globalThis.crypto,
) {
  if (!identity?.key || !identity?.did) throw new Error('Generate or import a DID first.');
  const normalizedRoom = normalizeRoom(room);
  const normalizedNonce = String(nonce || '').trim();
  if (!/^[0-9]{1,19}$/.test(normalizedNonce)) {
    throw new Error('Nonce must contain 1–19 digits.');
  }
  const text = cleanTechnocoreText(message);
  if (!text) throw new Error('Write a message before signing.');
  if (text.length > 4096) throw new Error('Messages cannot exceed 4096 characters.');
  const canonical = `${normalizedRoom}|${normalizedNonce}|${text}`;
  const signature = await cryptoApi.subtle.sign(
    'Ed25519', identity.key, new TextEncoder().encode(canonical),
  );
  return {
    room: normalizedRoom,
    did: identity.did,
    sig: encodeBase64url(new Uint8Array(signature)),
    nonce: normalizedNonce,
    text,
    canonical,
  };
}

export function normalizeTechnocoreOrigin(origin) {
  let server;
  try {
    server = new URL(String(origin || '').trim());
  } catch (_) {
    throw new Error('Enter a valid Technocore server URL.');
  }
  const local = server.hostname === 'localhost' || server.hostname === '127.0.0.1';
  if (server.protocol !== 'https:' && !(local && server.protocol === 'http:')) {
    throw new Error('The Technocore server must use HTTPS.');
  }
  return server.origin;
}

function nonceScope(origin, did, room) {
  return `${normalizeTechnocoreOrigin(origin)}|${String(did || '')}|${normalizeRoom(room)}`;
}

function nonceRecords(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(NONCE_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function loadTechnocoreNonce(storage, origin, did, room) {
  const record = nonceRecords(storage)[nonceScope(origin, did, room)];
  const nonce = Number(record?.nonce);
  return Number.isSafeInteger(nonce) && nonce >= 0 ? nonce : 0;
}

export function saveTechnocoreNonce(storage, origin, did, room, nonce, now = Date.now()) {
  const numeric = Number(nonce);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error('Cannot save an invalid nonce.');
  const scope = nonceScope(origin, did, room);
  const records = nonceRecords(storage);
  const current = Number(records[scope]?.nonce) || 0;
  records[scope] = { nonce: Math.max(current, numeric), updatedAt: now };
  const trimmed = Object.fromEntries(
    Object.entries(records)
      .sort((left, right) => Number(right[1]?.updatedAt) - Number(left[1]?.updatedAt))
      .slice(0, MAX_SAVED_NONCES),
  );
  try {
    storage?.setItem(NONCE_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (_) {
    // A timestamp nonce still works when browser storage is unavailable.
  }
  return records[scope].nonce;
}

export function nextTechnocoreNonce(storage, origin, did, room, now = Date.now()) {
  return String(Math.max(Number(now) || 0, loadTechnocoreNonce(storage, origin, did, room) + 1));
}

export function buildSignedMessageUrl(origin, signed) {
  const server = normalizeTechnocoreOrigin(origin);
  const parts = [signed.room, 'say-signed', signed.did, signed.sig, signed.nonce, signed.text]
    .map((part) => encodeURIComponent(part));
  return `${server}/r/${parts.join('/')}`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

async function proxyJson(
  operation,
  params = {},
  { endpoint = '/api/technocore', fetchApi = globalThis.fetch, signal, method = 'GET', body } = {},
) {
  if (typeof fetchApi !== 'function') throw new Error('Fetch is unavailable in this browser.');
  const url = new URL(endpoint, globalThis.location?.origin || 'http://localhost');
  url.searchParams.set('op', operation);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetchApi(url.toString(), {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    throw new TechnocoreHttpError(
      text.trim() || `Technocore returned HTTP ${response.status}.`,
      response.status,
      retryAfter,
    );
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new TechnocoreHttpError('Technocore returned unreadable JSON.', 502);
  }
}

export function listTechnocoreRooms(options = {}) {
  const limit = boundedInteger(options.limit, 50, 0, 200);
  return proxyJson('rooms', { limit }, options);
}

export function readTechnocoreRoom(room, options = {}) {
  const normalized = normalizeRoom(room);
  const limit = boundedInteger(options.limit, 50, 1, 200);
  const since = boundedInteger(options.since, null, 0, Number.MAX_SAFE_INTEGER);
  const wait = Math.min(10, Math.max(0, Number(options.wait) || 0));
  return proxyJson('room', { room: normalized, limit, since, wait }, options);
}

export function readTclkPaperRecord(contract, options = {}) {
  const normalized = String(contract || '').trim().toLowerCase();
  if (!TCLK_CONTRACT_RE.test(normalized)) throw new Error('Enter a valid tclk contract id.');
  return proxyJson('paper', { contract: normalized }, options);
}

export function postSignedTechnocoreMessage(signed, options = {}) {
  const room = normalizeRoom(signed?.room);
  return proxyJson(
    'post',
    { room },
    {
      ...options,
      method: 'POST',
      body: {
        did: signed.did,
        sig: signed.sig,
        nonce: signed.nonce,
        text: signed.text,
      },
    },
  );
}
