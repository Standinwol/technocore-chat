import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handleTechnocoreProxy } from '../client/api/technocore.mjs';
import { renderRoomMessages } from '../client/room-ui.mjs';
import {
  TechnocoreHttpError,
  listTechnocoreRooms,
  loadTechnocoreNonce,
  nextTechnocoreNonce,
  normalizeRoom,
  postSignedTechnocoreMessage,
  readTechnocoreRoom,
  readTclkPaperRecord,
  saveTechnocoreNonce,
} from '../client/technocore.mjs';

assert.equal(normalizeRoom('  Technocore  '), 'technocore');
assert.throws(() => normalizeRoom('bad room'), /Room names/);

const clientRequests = [];
const clientFetch = async (url, init) => {
  clientRequests.push({ url: new URL(url), init });
  return new Response(JSON.stringify({
    room: 'technocore',
    rooms: [{ room: 'technocore', topic: '<b>untrusted</b>' }],
    messages: [{ seq: 8, from: 'alice', text: '<img src=x>', ts: 'now' }],
    first_seq: 8,
    last_seq: 8,
  }), { headers: { 'Content-Type': 'application/json' } });
};

const directory = await listTechnocoreRooms({ limit: 12, fetchApi: clientFetch });
assert.equal(directory.rooms[0].room, 'technocore');
assert.equal(clientRequests[0].url.pathname, '/api/technocore');
assert.equal(clientRequests[0].url.searchParams.get('op'), 'rooms');
assert.equal(clientRequests[0].url.searchParams.get('limit'), '12');

const room = await readTechnocoreRoom('Technocore', {
  since: 7,
  wait: 99,
  fetchApi: clientFetch,
});
assert.equal(room.messages[0].seq, 8);
assert.equal(clientRequests[1].url.searchParams.get('room'), 'technocore');
assert.equal(clientRequests[1].url.searchParams.get('since'), '7');
assert.equal(clientRequests[1].url.searchParams.get('wait'), '10');

const nonceValues = new Map();
const nonceStorage = {
  getItem: (key) => nonceValues.get(key) ?? null,
  setItem: (key, value) => nonceValues.set(key, value),
};
const nonceDid = 'did:key:z6Mktest';
assert.equal(nextTechnocoreNonce(
  nonceStorage, 'https://technocore.chat', nonceDid, 'technocore', 1000,
), '1000');
saveTechnocoreNonce(
  nonceStorage, 'https://technocore.chat', nonceDid, 'technocore', '1000', 10,
);
assert.equal(loadTechnocoreNonce(
  nonceStorage, 'https://technocore.chat', nonceDid, 'technocore',
), 1000);
assert.equal(nextTechnocoreNonce(
  nonceStorage, 'https://technocore.chat', nonceDid, 'technocore', 900,
), '1001');

const signed = {
  room: 'technocore',
  did: nonceDid,
  sig: 'signature',
  nonce: '1001',
  text: 'BTC price',
};
const posted = await postSignedTechnocoreMessage(signed, {
  fetchApi: async (url, init) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.searchParams.get('op'), 'post');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), {
      did: signed.did,
      sig: signed.sig,
      nonce: signed.nonce,
      text: signed.text,
    });
    return new Response(JSON.stringify({ posted: { seq: 9, ...signed } }));
  },
});
assert.equal(posted.posted.seq, 9);

const paperContract = `0x${'ab'.repeat(32)}`;
const paperClient = await readTclkPaperRecord(paperContract, {
  fetchApi: async (url) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.searchParams.get('op'), 'paper');
    assert.equal(requestUrl.searchParams.get('contract'), paperContract);
    return new Response(JSON.stringify({ contract: paperContract, value: null }));
  },
});
assert.equal(paperClient.value, null);
assert.throws(() => readTclkPaperRecord('not-a-contract'), /valid tclk contract/);

await assert.rejects(
  readTechnocoreRoom('technocore', {
    fetchApi: async () => new Response('slow down', {
      status: 429,
      headers: { 'Retry-After': '3' },
    }),
  }),
  (error) => error instanceof TechnocoreHttpError
    && error.status === 429
    && error.retryAfter === 3,
);

const upstreamRequests = [];
const upstreamFetch = async (url, init) => {
  upstreamRequests.push({ url: new URL(url), init });
  return new Response(JSON.stringify({ messages: [], first_seq: 0, last_seq: 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

const proxiedRoom = await handleTechnocoreProxy(
  new Request('https://signal.test/api/technocore?op=room&room=technocore&since=4&wait=10'),
  upstreamFetch,
  'https://chat.example',
);
assert.equal(proxiedRoom.status, 200);
assert.equal(proxiedRoom.headers.get('cache-control'), 'no-store');
assert.equal(upstreamRequests[0].url.origin, 'https://chat.example');
assert.equal(upstreamRequests[0].url.pathname, '/r/technocore');
assert.equal(upstreamRequests[0].url.searchParams.get('since'), '4');
assert.equal(upstreamRequests[0].url.searchParams.get('wait'), '10');

const proxiedPost = await handleTechnocoreProxy(
  new Request('https://signal.test/api/technocore?op=post&room=technocore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...signed,
      did: `did:key:z6Mk${'1'.repeat(44)}`,
      sig: 'A'.repeat(86),
    }),
  }),
  upstreamFetch,
  'https://chat.example',
);
assert.equal(proxiedPost.status, 200);
assert.equal(upstreamRequests[1].url.pathname, '/r/technocore');
assert.equal(upstreamRequests[1].init.method, 'POST');
assert.deepEqual(JSON.parse(upstreamRequests[1].init.body), {
  did: `did:key:z6Mk${'1'.repeat(44)}`,
  sig: 'A'.repeat(86),
  nonce: signed.nonce,
  text: signed.text,
});

const paperValue = `tclkpaper1 locked hash 0x${'11'.repeat(32)} 2000000000000`;
const proxiedPaper = await handleTechnocoreProxy(
  new Request(`https://signal.test/api/technocore?op=paper&contract=${paperContract}`),
  async (url) => {
    const upstreamUrl = new URL(url);
    assert.equal(upstreamUrl.pathname, `/kv/tclk-paper-ab/${'ab'.repeat(7)}`);
    return new Response(`warning\n${paperValue}\n`);
  },
  'https://chat.example',
);
assert.equal(proxiedPaper.status, 200);
assert.deepEqual(await proxiedPaper.json(), { contract: paperContract, value: paperValue });

const missingPaper = await handleTechnocoreProxy(
  new Request(`https://signal.test/api/technocore?op=paper&contract=${paperContract}`),
  async () => new Response('missing', { status: 404 }),
  'https://chat.example',
);
assert.deepEqual(await missingPaper.json(), { contract: paperContract, value: null });

const rejectedRoom = await handleTechnocoreProxy(
  new Request('https://signal.test/api/technocore?op=room&room=../../secret'),
  async () => { throw new Error('must not fetch'); },
);
assert.equal(rejectedRoom.status, 400);

const rejectedCrossOrigin = await handleTechnocoreProxy(
  new Request('https://signal.test/api/technocore?op=rooms', {
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  }),
  async () => { throw new Error('must not fetch'); },
);
assert.equal(rejectedCrossOrigin.status, 403);

const rejectedUnsignedPost = await handleTechnocoreProxy(
  new Request('https://signal.test/api/technocore?op=post&room=technocore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'unsigned proxy write' }),
  }),
  async () => { throw new Error('must not fetch'); },
);
assert.equal(rejectedUnsignedPost.status, 400);

const roomUiSource = readFileSync(new URL('../client/room-ui.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(roomUiSource, /innerHTML|insertAdjacentHTML/);
assert.match(roomUiSource, /textContent/);

function fakeElement(tagName) {
  let text = '';
  return {
    tagName,
    children: [],
    dataset: {},
    scrollHeight: 100,
    scrollTop: 0,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    set textContent(value) {
      text = String(value);
      if (!text) this.children = [];
    },
    get textContent() { return text; },
  };
}

globalThis.document = { createElement: (tagName) => fakeElement(tagName) };
const roomContainer = fakeElement('div');
renderRoomMessages(roomContainer, [{
  seq: 9,
  from: nonceDid,
  text: 'direct room message',
  ts: 'now',
}], { userDid: nonceDid });
assert.equal(roomContainer.children[0].className, 'room-message own');
assert.equal(roomContainer.children[0].dataset.tclk, 'false');
assert.match(roomContainer.children[0].children[0].children[0].textContent, /^You · /);
renderRoomMessages(roomContainer, [{
  seq: 10,
  from: nonceDid,
  text: 'tclk1 {"type":"test"}',
  ts: 'now',
}], { userDid: nonceDid });
assert.equal(roomContainer.children[1].dataset.tclk, 'true');
delete globalThis.document;

console.log('client technocore probe: ok');
