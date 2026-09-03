import {
  applyFrame,
  decodeFrame,
  decodePaperRecord,
  isTclkLine,
  OFFER_ROOM,
  openContract,
} from '@flop-labs/tclk';

const TERMINAL = new Set(['claimed', 'refunded', 'cancelled']);
export const TCLK_OFFER_ROOM = OFFER_ROOM;

function numericSequence(message, fallback) {
  const value = Number(message?.seq);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function messageTime(message, fallback) {
  const value = Date.parse(String(message?.ts || ''));
  return Number.isFinite(value) ? value : fallback;
}

function inspectTclkMessage(message, index) {
  const text = String(message?.text ?? '');
  if (!isTclkLine(text)) return null;
  const inspected = {
    message,
    seq: numericSequence(message, index + 1),
    time: messageTime(message, 0),
  };
  try {
    inspected.frame = decodeFrame(text);
  } catch (error) {
    return { ...inspected, ok: false, reason: String(error?.message || error) };
  }
  if (message?.from !== inspected.frame.from) {
    return {
      ...inspected,
      ok: false,
      reason: 'Technocore signer does not match frame.from.',
    };
  }
  return { ...inspected, ok: true };
}

function sortBySequence(left, right) {
  return left.seq - right.seq;
}

function applyEvent(state, event, now) {
  const result = applyFrame(state, event.frame, event.time || now);
  return {
    state: result.state,
    timelineEvent: {
      type: event.frame.type,
      seq: event.seq,
      ok: result.ok,
      reason: result.ok ? '' : result.reason,
    },
  };
}

function dealFromOffer(offerEvent, acceptEvent, contractEvents, now) {
  let state = openContract(offerEvent.frame);
  const timeline = [{ type: 'offer', seq: offerEvent.seq, ok: true, reason: '' }];
  let contract = '';

  if (acceptEvent) {
    contract = acceptEvent.frame.contract;
    const events = [acceptEvent, ...contractEvents].sort(sortBySequence);
    for (const event of events) {
      if (event.seq <= offerEvent.seq) {
        timeline.push({
          type: event.frame.type,
          seq: event.seq,
          ok: false,
          reason: 'Frame precedes its offer in the room transcript.',
        });
        continue;
      }
      const applied = applyEvent(state, event, now);
      state = applied.state;
      timeline.push(applied.timelineEvent);
    }
  }

  const expired = state.status === 'proposed' && now >= offerEvent.frame.expiresMs;
  return {
    id: contract || offerEvent.frame.id,
    contract,
    offer: offerEvent.frame,
    state,
    status: expired ? 'expired' : state.status,
    timeline,
    latestSeq: Math.max(...timeline.map((event) => event.seq)),
    rejected: timeline.filter((event) => !event.ok),
  };
}

export function analyzeTclkMessages(messages, now = Date.now()) {
  const inspected = (Array.isArray(messages) ? messages : [])
    .map(inspectTclkMessage)
    .filter(Boolean)
    .sort(sortBySequence);
  const invalid = inspected.filter((event) => !event.ok);
  const valid = inspected.filter((event) => event.ok);

  const offers = new Map();
  for (const event of valid) {
    if (event.frame.type === 'offer' && !offers.has(event.frame.id)) {
      offers.set(event.frame.id, event);
    }
  }

  const acceptsByOffer = new Map();
  for (const event of valid) {
    if (event.frame.type !== 'accept') continue;
    const accepts = acceptsByOffer.get(event.frame.ref) || [];
    accepts.push(event);
    acceptsByOffer.set(event.frame.ref, accepts);
  }

  const deals = [];
  const usedSequences = new Set();
  for (const [offerId, offerEvent] of offers) {
    usedSequences.add(offerEvent.seq);
    const accepts = acceptsByOffer.get(offerId) || [];
    if (!accepts.length) {
      deals.push(dealFromOffer(offerEvent, null, [], now));
      continue;
    }
    for (const acceptEvent of accepts) {
      usedSequences.add(acceptEvent.seq);
      const contractEvents = valid.filter((event) => (
        event.frame.type !== 'offer'
        && event.frame.type !== 'accept'
        && event.frame.contract === acceptEvent.frame.contract
      ));
      for (const event of contractEvents) usedSequences.add(event.seq);
      deals.push(dealFromOffer(offerEvent, acceptEvent, contractEvents, now));
    }
  }

  deals.sort((left, right) => right.latestSeq - left.latestSeq);
  const orphaned = valid.filter((event) => !usedSequences.has(event.seq));
  return {
    frameCount: inspected.length,
    validCount: valid.length,
    invalid,
    orphaned,
    deals,
  };
}

export function checkPaperRecord(deal, value) {
  if (!deal?.contract || deal?.state?.rail !== 'paper') {
    return { status: 'not-applicable', label: 'No PAPER lock' };
  }
  if (value?.loading) {
    return { status: 'pending', label: 'Checking PAPER record…' };
  }
  if (value?.unavailable) {
    return { status: 'unavailable', label: 'PAPER record unavailable' };
  }
  if (value === null || value === undefined || value === '') {
    return { status: 'missing', label: 'PAPER record missing' };
  }
  const record = decodePaperRecord(String(value).trim());
  if (!record) return { status: 'invalid', label: 'PAPER record malformed' };
  const termsMatch = record.lock === deal.offer.lock
    && record.statement === deal.state.statement
    && record.refundAfterMs === deal.offer.refundAfterMs
    && (record.status !== 'claimed' || record.secret === deal.state.secret);
  const expectedStatus = TERMINAL.has(deal.state.status) ? deal.state.status : 'locked';
  const statusMatches = record.status === expectedStatus
    || (deal.state.status === 'claimed' && record.status === 'locked');
  if (!termsMatch || !statusMatches) {
    return { status: 'mismatch', label: `PAPER ${record.status} · mismatch`, record };
  }
  const pending = deal.state.status === 'claimed' && record.status === 'locked';
  return {
    status: pending ? 'pending' : 'verified',
    label: pending ? 'PAPER locked · claim pending' : `PAPER ${record.status} · matches`,
    record,
  };
}

export function tclkSummaryText(analysis) {
  if (!analysis.frameCount) return 'No tclk/1 frames in the loaded room history.';
  const parts = [
    `${analysis.deals.length} deal${analysis.deals.length === 1 ? '' : 's'}`,
    `${analysis.validCount} valid frame${analysis.validCount === 1 ? '' : 's'}`,
  ];
  if (analysis.invalid.length) parts.push(`${analysis.invalid.length} invalid`);
  if (analysis.orphaned.length) parts.push(`${analysis.orphaned.length} unresolved`);
  return parts.join(' · ');
}

function shortValue(value, head = 10, tail = 6) {
  const text = String(value || '');
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function contactButton(label, action, did, sequence) {
  const button = element('button', 'contact-action', label);
  button.type = 'button';
  button.dataset.contactAction = action;
  button.dataset.did = did;
  button.dataset.seq = String(sequence ?? '');
  button.title = action === 'copy-did'
    ? `Copy ${did}`
    : `Reply to ${did} about offer #${sequence ?? '?'}`;
  button.setAttribute?.('aria-label', button.title);
  return button;
}

function renderDeal(deal, paperRecords) {
  const card = element('article', 'tclk-deal');
  const heading = element('div', 'tclk-deal-heading');
  const identity = element('div');
  const title = element('strong', '', `${deal.offer.amount} ${deal.offer.asset}`);
  const reference = element('code', 'tclk-reference', shortValue(deal.id));
  reference.title = deal.id;
  identity.append(title, reference);
  const status = element('span', `tclk-status ${deal.status}`, deal.status);
  heading.append(identity, status);

  const facts = element('div', 'tclk-facts');
  const role = deal.offer.role === 'payer' ? 'Payer offered' : 'Payee offered';
  facts.append(
    element('span', '', role),
    element('span', '', `Lock: ${deal.offer.lock}`),
    element('span', '', `Rails: ${deal.offer.rails.join(', ')}`),
  );

  if (deal.contract && deal.state.rail === 'paper') {
    const paperValue = paperRecords?.has(deal.contract)
      ? paperRecords.get(deal.contract)
      : { loading: true };
    const paper = checkPaperRecord(deal, paperValue);
    facts.append(element('span', `tclk-paper ${paper.status}`, paper.label));
  }

  const offerSequence = deal.timeline[0]?.seq;
  const contact = element('div', 'tclk-contact');
  const maker = element('code', 'tclk-maker', `Maker ${shortValue(deal.offer.from, 14, 6)}`);
  maker.title = deal.offer.from;
  const contactActions = element('span', 'contact-actions');
  contactActions.append(
    contactButton('Copy DID', 'copy-did', deal.offer.from, offerSequence),
    contactButton('Reply', 'reply', deal.offer.from, offerSequence),
  );
  contact.append(maker, contactActions);

  const timeline = element('ol', 'tclk-timeline');
  for (const event of deal.timeline) {
    const item = element('li', event.ok ? 'accepted' : 'rejected');
    const step = element('span', 'tclk-step', event.type);
    const sequence = element('span', '', `#${event.seq}`);
    item.append(step, sequence);
    if (event.reason) item.title = event.reason;
    timeline.appendChild(item);
  }
  card.append(heading, facts, contact, timeline);

  if (deal.rejected.length) {
    const warning = element(
      'p',
      'tclk-warning',
      `Rejected: ${deal.rejected.map((event) => `${event.type} #${event.seq}: ${event.reason}`).join(' · ')}`,
    );
    card.appendChild(warning);
  }
  return card;
}

export function renderTclkDeals(container, analysis, paperRecords = new Map()) {
  container.textContent = '';
  if (!analysis.frameCount) {
    container.appendChild(element('p', 'tclk-empty', 'Connect to a room carrying tclk/1 frames to inspect its deals.'));
    return;
  }
  for (const deal of analysis.deals) container.appendChild(renderDeal(deal, paperRecords));
  if (!analysis.deals.length) {
    container.appendChild(element('p', 'tclk-empty', 'No complete offer was found in the loaded history window.'));
  }
  const issues = [...analysis.invalid, ...analysis.orphaned];
  if (issues.length) {
    const list = element('ul', 'tclk-issues');
    for (const issue of issues.slice(0, 6)) {
      const reason = issue.reason || `No matching offer/contract for ${issue.frame?.type || 'frame'}.`;
      list.appendChild(element('li', '', `#${issue.seq}: ${reason}`));
    }
    container.appendChild(list);
  }
}
