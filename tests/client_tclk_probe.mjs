import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  hashLockFromPreimage,
  makeAccept,
  makeOffer,
  encodeFrame,
} from '@flop-labs/tclk';
import { createIdentity } from '../client/identity.mjs';
import {
  analyzeTclkMessages,
  checkPaperRecord,
  renderTclkDeals,
  TCLK_OFFER_ROOM,
  tclkSummaryText,
} from '../client/tclk-viewer.mjs';

assert.equal(TCLK_OFFER_ROOM, 'tclk-offers');

const payer = await createIdentity('11'.repeat(32), webcrypto);
const payee = await createIdentity('22'.repeat(32), webcrypto);
const now = 2_000_000_000_000;
const offer = makeOffer({
  from: payer.did,
  role: 'payer',
  amount: '1000000',
  asset: 'PAPER',
  lock: 'hash',
  rails: ['paper'],
  expiresMs: now + 60_000,
  claimByMs: now + 120_000,
  refundAfterMs: now + 180_000,
  nonce: '0102030405060708',
});
const secret = hashLockFromPreimage(`0x${'ab'.repeat(32)}`);
const accept = makeAccept(offer, {
  from: payee.did,
  statement: secret.hash,
  nonce: '1112131415161718',
});
const lock = {
  type: 'lock',
  from: payer.did,
  contract: accept.contract,
  rail: 'paper',
  ref: accept.contract,
};
const reveal = {
  type: 'reveal',
  from: payee.did,
  contract: accept.contract,
  secret: secret.preimage,
};
const receipt = {
  type: 'receipt',
  from: payer.did,
  contract: accept.contract,
  outcome: 'claimed',
};

function message(seq, from, frame, offset = seq * 1000) {
  return {
    seq,
    from,
    text: encodeFrame(frame),
    ts: new Date(now + offset).toISOString(),
  };
}

const transcript = [
  message(1, payer.did, offer),
  message(2, payee.did, accept),
  message(3, payer.did, lock),
  message(4, payee.did, reveal),
  message(5, payer.did, receipt),
];
const analysis = analyzeTclkMessages(transcript, now + 10_000);
assert.equal(analysis.frameCount, 5);
assert.equal(analysis.validCount, 5);
assert.equal(analysis.invalid.length, 0);
assert.equal(analysis.orphaned.length, 0);
assert.equal(analysis.deals.length, 1);
assert.equal(analysis.deals[0].contract, accept.contract);
assert.equal(analysis.deals[0].status, 'claimed');
assert.deepEqual(
  analysis.deals[0].timeline.map((event) => [event.type, event.ok]),
  [['offer', true], ['accept', true], ['lock', true], ['reveal', true], ['receipt', true]],
);
assert.equal(tclkSummaryText(analysis), '1 deal · 5 valid frames');

const paperValue = `tclkpaper1 claimed hash ${secret.hash} ${offer.refundAfterMs} ${secret.preimage}`;
assert.equal(checkPaperRecord(analysis.deals[0], paperValue).status, 'verified');
assert.equal(checkPaperRecord(analysis.deals[0], { loading: true }).status, 'pending');
assert.equal(checkPaperRecord(analysis.deals[0], null).status, 'missing');
assert.equal(checkPaperRecord(analysis.deals[0], { unavailable: true }).status, 'unavailable');
assert.equal(
  checkPaperRecord(analysis.deals[0], `tclkpaper1 claimed hash ${'0x' + '00'.repeat(32)} ${offer.refundAfterMs} ${secret.preimage}`).status,
  'mismatch',
);

const hostile = analyzeTclkMessages([
  ...transcript,
  { seq: 6, from: payer.did, text: 'tclk1 {bad json', ts: new Date(now + 6000).toISOString() },
  message(7, payee.did, offer),
  message(8, payer.did, {
    type: 'lock',
    from: payer.did,
    contract: `0x${'99'.repeat(32)}`,
    rail: 'paper',
    ref: `0x${'99'.repeat(32)}`,
  }),
], now + 10_000);
assert.equal(hostile.invalid.length, 2);
assert.match(hostile.invalid[0].reason, /valid JSON/);
assert.match(hostile.invalid[1].reason, /signer does not match/);
assert.equal(hostile.orphaned.length, 1);
assert.match(tclkSummaryText(hostile), /2 invalid/);
assert.match(tclkSummaryText(hostile), /1 unresolved/);

const prematureReceipt = analyzeTclkMessages([
  message(1, payer.did, offer),
  message(2, payee.did, accept),
  message(3, payer.did, receipt),
], now + 10_000);
assert.equal(prematureReceipt.deals[0].status, 'accepted');
assert.equal(prematureReceipt.deals[0].rejected.length, 1);
assert.match(prematureReceipt.deals[0].rejected[0].reason, /before a terminal status/);

const expired = analyzeTclkMessages([message(1, payer.did, offer)], offer.expiresMs);
assert.equal(expired.deals[0].status, 'expired');

function fakeElement(tagName) {
  let text = '';
  return {
    tagName,
    children: [],
    className: '',
    dataset: {},
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
const container = fakeElement('div');
renderTclkDeals(container, analysis, new Map([[accept.contract, paperValue]]));
assert.equal(container.children[0].className, 'tclk-deal');
assert.equal(container.children[0].children[0].children[1].textContent, 'claimed');
assert.match(container.children[0].children[2].children[0].textContent, /^Maker /);
assert.equal(container.children[0].children[2].children[0].title, payer.did);
assert.equal(container.children[0].children[2].children[1].children[0].dataset.did, payer.did);
assert.equal(container.children[0].children[2].children[1].children[1].dataset.seq, '1');
delete globalThis.document;

console.log('client tclk probe: ok');
