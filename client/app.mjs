import {
  clearIdentitySeed,
  createIdentity,
  hex,
  loadIdentitySeed,
  parseIdentityBackup,
  saveIdentitySeed,
} from './identity.mjs';
import {
  API_URL,
  STREAM_URL,
  WATCHLIST_KEY,
  DEFAULT_SYMBOLS,
  MAX_SYMBOLS,
  answerCryptoQuery,
  buildPeriodicReport,
  formatPrice,
  normalizeSymbol,
  tickerFromRest,
  tickerFromStream,
} from './market.mjs';
import {
  claimTclkPaperRecord,
  listTechnocoreRooms,
  nextTechnocoreNonce,
  normalizeRoom,
  postSignedTechnocoreMessage,
  readTechnocoreRoom,
  readTclkPaperRecord,
  saveTechnocoreNonce,
  signTechnocoreMessage,
  writeTclkPaperLock,
} from './technocore.mjs';
import { populateRoomOptions, renderRoomMessages } from './room-ui.mjs';
import {
  analyzeTclkMessages,
  encodeTclkFrame,
  makePaperDemoAccept,
  makePaperDemoLock,
  makePaperDemoOffer,
  makePaperDemoReceipt,
  makePaperDemoReveal,
  renderTclkDeals,
  TCLK_OFFER_ROOM,
  tclkSummaryText,
} from './tclk-viewer.mjs';

const TECHNOCORE_ORIGIN = 'https://technocore.chat';
const TCLK_DEMO_STORAGE_KEY = 'signal-id-tclk-paper-demo-v1';

export {
  canonicalSnapshot,
  clearIdentitySeed,
  createIdentity,
  loadIdentitySeed,
  parseIdentityBackup,
  saveIdentitySeed,
  signSnapshot,
} from './identity.mjs';
export {
  answerCryptoQuery,
  buildPeriodicReport,
  formatPrice,
  normalizeSymbol,
  tickerFromRest,
  tickerFromStream,
} from './market.mjs';
export {
  buildSignedMessageUrl,
  cleanTechnocoreText,
  claimTclkPaperRecord,
  listTechnocoreRooms,
  normalizeTechnocoreOrigin,
  normalizeRoom,
  postSignedTechnocoreMessage,
  readTechnocoreRoom,
  readTclkPaperRecord,
  signTechnocoreMessage,
  writeTclkPaperLock,
} from './technocore.mjs';

function startApp() {
  const elements = {
    seed: document.getElementById('seed'),
    seedFile: document.getElementById('seed-file'),
    did: document.getElementById('did'),
    identityState: document.getElementById('identity-state'),
    identityMessage: document.getElementById('identity-message'),
    marketStatus: document.getElementById('market-status'),
    liveDot: document.getElementById('live-dot'),
    marketMessage: document.getElementById('market-message'),
    tickerList: document.getElementById('ticker-list'),
    symbol: document.getElementById('symbol'),
    agentLog: document.getElementById('agent-log'),
    agentQuestion: document.getElementById('agent-question'),
    reportInterval: document.getElementById('report-interval'),
    reportStatus: document.getElementById('report-status'),
    roomConnectionState: document.getElementById('room-connection-state'),
    roomSelect: document.getElementById('room-select'),
    chatRoom: document.getElementById('chat-room'),
    roomStatus: document.getElementById('room-status'),
    roomCursor: document.getElementById('room-cursor'),
    roomLog: document.getElementById('room-log'),
    roomComposer: document.getElementById('room-composer'),
    roomMessage: document.getElementById('room-message'),
    roomComposeStatus: document.getElementById('room-compose-status'),
    roomMessageFilter: document.getElementById('room-message-filter'),
    tclkSummary: document.getElementById('tclk-summary'),
    tclkDeals: document.getElementById('tclk-deals'),
    tclkDemoAsset: document.getElementById('tclk-demo-asset'),
    tclkDemoAmount: document.getElementById('tclk-demo-amount'),
    tclkDemoPayer: document.getElementById('tclk-demo-payer'),
    tclkDemoPayee: document.getElementById('tclk-demo-payee'),
    tclkDemoContract: document.getElementById('tclk-demo-contract'),
    tclkDemoStatus: document.getElementById('tclk-demo-status'),
  };
  const buttons = {
    copyDid: document.getElementById('copy-did'),
    copySeed: document.getElementById('copy-seed'),
    downloadSeed: document.getElementById('download-seed'),
    forget: document.getElementById('forget-did'),
    importSeedFile: document.getElementById('import-seed-file'),
    useAgentAnswer: document.getElementById('use-agent-answer'),
    refreshRooms: document.getElementById('refresh-rooms'),
    connectRoom: document.getElementById('connect-room'),
    sendRoomMessage: document.getElementById('send-room-message'),
    tclkDemoConnect: document.getElementById('tclk-demo-connect'),
    tclkDemoReset: document.getElementById('tclk-demo-reset'),
    tclkDemoOffer: document.getElementById('tclk-demo-offer'),
    tclkDemoAccept: document.getElementById('tclk-demo-accept'),
    tclkDemoLock: document.getElementById('tclk-demo-lock'),
    tclkDemoReveal: document.getElementById('tclk-demo-reveal'),
    tclkDemoReceipt: document.getElementById('tclk-demo-receipt'),
  };
  let identity = null;
  let tickers = new Map();
  let socket = null;
  let streamGeneration = 0;
  let reconnectTimer = null;
  let latestAgentAnswer = '';
  let reportTimer = null;
  let nextReportAt = 0;
  let reportCountdown = null;
  let roomAbort = null;
  let activeRoom = '';
  let roomCursor = 0;
  let roomPosting = false;
  let roomTranscript = [];
  let tclkAnalysis = analyzeTclkMessages([]);
  let tclkDemo = loadTclkDemoState();
  let tclkDemoBusy = false;
  let tclkDemoNotice = null;
  const renderedRoomSequences = new Set();
  const tclkPaperRecords = new Map();
  const tclkPaperReads = new Map();

  function loadWatchlist() {
    try {
      const value = JSON.parse(localStorage.getItem(WATCHLIST_KEY));
      if (Array.isArray(value)) {
        const valid = [...new Set(value.filter((symbol) => /^[A-Z0-9]{5,16}$/.test(symbol) && symbol.endsWith('USDT')))];
        if (valid.length) return valid.slice(0, MAX_SYMBOLS);
      }
    } catch (_) {
      // Storage can be disabled. A temporary watchlist is enough.
    }
    return [...DEFAULT_SYMBOLS];
  }

  let symbols = loadWatchlist();

  function saveWatchlist() {
    try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols)); } catch (_) { /* no-op */ }
  }

  function quoteAsset(symbol) { return symbol.slice(0, -4); }

  function compactNumber(value) {
    if (!Number.isFinite(value)) return '—';
    return '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
  }

  function renderMarket() {
    elements.tickerList.textContent = '';
    if (!symbols.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'empty-row';
      cell.textContent = 'Your watchlist is empty. Add an asset above.';
      row.appendChild(cell);
      elements.tickerList.appendChild(row);
      return;
    }

    for (const symbol of symbols) {
      const ticker = tickers.get(symbol);
      const row = document.createElement('tr');
      row.dataset.symbol = symbol;

      const assetCell = document.createElement('td');
      const asset = document.createElement('div');
      asset.className = 'asset';
      const icon = document.createElement('span');
      icon.className = 'asset-icon';
      icon.textContent = quoteAsset(symbol).slice(0, 2);
      const name = document.createElement('span');
      name.className = 'asset-name';
      const strong = document.createElement('strong');
      strong.textContent = quoteAsset(symbol);
      const pair = document.createElement('span');
      pair.textContent = symbol;
      name.append(strong, pair);
      asset.append(icon, name);
      assetCell.appendChild(asset);

      const priceCell = document.createElement('td');
      priceCell.className = 'price';
      priceCell.textContent = ticker ? formatPrice(ticker.price) : 'Loading…';

      const changeCell = document.createElement('td');
      const change = document.createElement('span');
      const changeValue = ticker?.change;
      change.className = 'change ' + (changeValue >= 0 ? 'positive' : 'negative');
      change.textContent = Number.isFinite(changeValue) ? `${changeValue >= 0 ? '+' : ''}${changeValue.toFixed(2)}%` : '—';
      changeCell.appendChild(change);

      const rangeCell = document.createElement('td');
      rangeCell.className = 'optional-column subtle-value';
      rangeCell.textContent = ticker ? `${formatPrice(ticker.low)} – ${formatPrice(ticker.high)}` : '—';

      const volumeCell = document.createElement('td');
      volumeCell.className = 'optional-column subtle-value';
      volumeCell.textContent = ticker ? compactNumber(ticker.volume) : '—';

      const actionCell = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-symbol';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${symbol}`);
      remove.addEventListener('click', () => removeSymbol(symbol));
      actionCell.appendChild(remove);

      row.append(assetCell, priceCell, changeCell, rangeCell, volumeCell, actionCell);
      elements.tickerList.appendChild(row);
    }
  }

  function setMarketState(message, connected) {
    elements.marketStatus.textContent = message;
    elements.liveDot.classList.toggle('connected', connected);
  }

  async function refreshMarket() {
    if (!symbols.length) return;
    elements.marketMessage.textContent = '';
    const url = API_URL + '?symbols=' + encodeURIComponent(JSON.stringify(symbols)) + '&type=FULL&symbolStatus=TRADING';
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.msg || `Binance returned HTTP ${response.status}`);
      const values = Array.isArray(body) ? body : [body];
      for (const value of values) tickers.set(value.symbol, tickerFromRest(value));
      const missing = symbols.filter((symbol) => !tickers.has(symbol));
      if (missing.length) elements.marketMessage.textContent = `No active Binance Spot market found for ${missing.join(', ')}.`;
      renderMarket();
    } catch (error) {
      elements.marketMessage.textContent = `Could not refresh Binance data: ${error.message}`;
    }
  }

  function connectStream() {
    streamGeneration += 1;
    const generation = streamGeneration;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
    if (!symbols.length) {
      socket = null;
      setMarketState('Watchlist is empty', false);
      return;
    }
    setMarketState('Connecting to Binance', false);
    const streams = symbols.map((symbol) => symbol.toLowerCase() + '@ticker').join('/');
    socket = new WebSocket(STREAM_URL + streams);
    socket.addEventListener('open', () => {
      if (generation === streamGeneration) setMarketState('Live · Binance Spot', true);
    });
    socket.addEventListener('message', (event) => {
      if (generation !== streamGeneration) return;
      try {
        const value = JSON.parse(event.data).data;
        if (value?.s && symbols.includes(value.s)) {
          tickers.set(value.s, tickerFromStream(value));
          renderMarket();
        }
      } catch (_) {
        elements.marketMessage.textContent = 'Received an unreadable market update.';
      }
    });
    socket.addEventListener('close', () => {
      if (generation !== streamGeneration) return;
      setMarketState('Reconnecting…', false);
      reconnectTimer = setTimeout(connectStream, 3000);
    });
    socket.addEventListener('error', () => {
      if (generation === streamGeneration) setMarketState('Market stream interrupted', false);
    });
  }

  function marketChanged() {
    saveWatchlist();
    renderMarket();
    refreshMarket();
    connectStream();
  }

  function removeSymbol(symbol) {
    symbols = symbols.filter((value) => value !== symbol);
    tickers.delete(symbol);
    marketChanged();
  }

  function setRoomState(label, detail, { active = false, error = false } = {}) {
    elements.roomConnectionState.textContent = label;
    elements.roomConnectionState.classList.toggle('active', active);
    elements.roomStatus.textContent = detail;
    elements.roomStatus.classList.toggle('error', error);
  }

  function setRoomComposerStatus(message, { error = false } = {}) {
    elements.roomComposeStatus.textContent = message;
    elements.roomComposeStatus.classList.toggle('error', error);
  }

  function refreshRoomComposer({ preserveStatus = false } = {}) {
    const hasMessage = Boolean(elements.roomMessage.value.trim());
    buttons.sendRoomMessage.disabled = !identity || !activeRoom || !hasMessage || roomPosting;
    if (preserveStatus) return;
    if (!identity) {
      setRoomComposerStatus('Generate or import a DID before sending a message.');
    } else if (!activeRoom) {
      setRoomComposerStatus('Connect to a room before sending a message.');
    } else {
      setRoomComposerStatus(`Messages are signed automatically and posted to /r/${activeRoom}.`);
    }
  }

  function updateRoomCursor(value) {
    roomCursor = Math.max(roomCursor, Number(value) || 0);
    elements.roomCursor.textContent = roomCursor ? `Sequence ${roomCursor}` : 'Sequence —';
  }

  function showEmptyRoom() {
    elements.roomLog.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'room-empty';
    empty.textContent = 'No messages in this room yet.';
    elements.roomLog.appendChild(empty);
  }

  function applyRoomMessageFilter() {
    const onlyTclk = elements.roomMessageFilter.value === 'tclk';
    for (const message of elements.roomLog.querySelectorAll('.room-message')) {
      message.hidden = onlyTclk && message.dataset.tclk !== 'true';
    }
  }

  function loadTclkDemoState() {
    try {
      const value = JSON.parse(sessionStorage.getItem(TCLK_DEMO_STORAGE_KEY) || 'null');
      if (value?.version !== 1
          || value.room !== TCLK_OFFER_ROOM
          || typeof value.payerDid !== 'string'
          || typeof value.payeeDid !== 'string'
          || !/^[0-9a-f]{64}$/.test(String(value.payeeSeed || ''))
          || !value.offer
          || !value.sequences
          || typeof value.sequences !== 'object') return null;
      return value;
    } catch (_) {
      return null;
    }
  }

  function saveTclkDemoState() {
    try {
      if (tclkDemo) sessionStorage.setItem(TCLK_DEMO_STORAGE_KEY, JSON.stringify(tclkDemo));
      else sessionStorage.removeItem(TCLK_DEMO_STORAGE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearTclkDemoState() {
    tclkDemo = null;
    tclkDemoNotice = null;
    saveTclkDemoState();
  }

  function shortTclkValue(value, head = 14, tail = 8) {
    const text = String(value || '');
    return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
  }

  function setTclkDemoFact(element, value, fallback) {
    const text = String(value || '');
    element.textContent = text ? shortTclkValue(text) : fallback;
    element.title = text;
  }

  function setTclkDemoNotice(text, kind = '') {
    tclkDemoNotice = { text, kind };
  }

  function refreshTclkDemo() {
    const sequences = tclkDemo?.sequences || {};
    const inRoom = activeRoom === TCLK_OFFER_ROOM;
    const ownsDemo = !tclkDemo || identity?.did === tclkDemo.payerDid;
    const enabled = Boolean(identity && inRoom && ownsDemo && !tclkDemoBusy);
    const completed = {
      offer: Boolean(sequences.offer),
      accept: Boolean(sequences.accept),
      lock: Boolean(sequences.lock && tclkDemo?.paperLocked),
      reveal: Boolean(sequences.reveal && tclkDemo?.paperClaimed),
      receipt: Boolean(sequences.receipt),
    };

    if (tclkDemo?.offer) {
      elements.tclkDemoAsset.value = tclkDemo.offer.asset;
      elements.tclkDemoAmount.value = tclkDemo.offer.amount;
    }
    elements.tclkDemoAsset.disabled = Boolean(tclkDemo) || tclkDemoBusy;
    elements.tclkDemoAmount.disabled = Boolean(tclkDemo) || tclkDemoBusy;
    buttons.tclkDemoConnect.disabled = inRoom || tclkDemoBusy;
    buttons.tclkDemoReset.disabled = !tclkDemo || tclkDemoBusy;
    buttons.tclkDemoOffer.disabled = !enabled || completed.offer;
    buttons.tclkDemoAccept.disabled = !enabled || !completed.offer || completed.accept;
    buttons.tclkDemoLock.disabled = !enabled || !completed.accept || completed.lock;
    buttons.tclkDemoReveal.disabled = !enabled || !completed.lock || completed.reveal;
    buttons.tclkDemoReceipt.disabled = !enabled || !completed.reveal || completed.receipt;

    buttons.tclkDemoOffer.textContent = tclkDemo && !sequences.offer ? 'Retry offer' : 'Post offer';
    buttons.tclkDemoAccept.textContent = tclkDemo?.accept && !sequences.accept
      ? 'Retry accept' : 'Accept as test payee';
    buttons.tclkDemoLock.textContent = tclkDemo?.paperLocked && !sequences.lock
      ? 'Post lock frame' : 'Lock PAPER';
    buttons.tclkDemoReveal.textContent = sequences.reveal && !tclkDemo?.paperClaimed
      ? 'Retry PAPER claim' : 'Reveal & claim';

    for (const [step, done] of Object.entries(completed)) {
      document.querySelector(`[data-demo-step="${step}"]`)?.classList.toggle('done', done);
    }
    setTclkDemoFact(elements.tclkDemoPayer, tclkDemo?.payerDid || identity?.did, 'Generate or import a DID');
    setTclkDemoFact(elements.tclkDemoPayee, tclkDemo?.payeeDid, 'Created at step 1');
    setTclkDemoFact(elements.tclkDemoContract, tclkDemo?.accept?.contract, 'Created at step 2');

    let notice = tclkDemoNotice;
    if (!notice) {
      if (!identity) notice = { text: 'Generate or import a DID first.', kind: '' };
      else if (tclkDemo && !ownsDemo) {
        notice = { text: 'This demo belongs to another payer DID. Restore it or start a new demo.', kind: 'error' };
      } else if (!inRoom) notice = { text: 'Open /r/tclk-offers to enable step 1.', kind: '' };
      else if (!completed.offer) notice = { text: 'Ready for step 1: post the test offer.', kind: '' };
      else if (!completed.accept) notice = { text: 'Offer posted. Continue with step 2.', kind: '' };
      else if (!completed.lock) notice = { text: 'Accepted. Continue with step 3.', kind: '' };
      else if (!completed.reveal) notice = { text: 'PAPER is locked. Continue with step 4.', kind: '' };
      else if (!completed.receipt) notice = { text: 'PAPER is claimed. Continue with step 5.', kind: '' };
      else notice = { text: 'Demo complete: offer → accept → lock → reveal → receipt.', kind: 'success' };
    }
    elements.tclkDemoStatus.textContent = notice.text;
    elements.tclkDemoStatus.classList.toggle('error', notice.kind === 'error');
    elements.tclkDemoStatus.classList.toggle('success', notice.kind === 'success');
  }

  function requireTclkDemo() {
    if (!identity) throw new Error('Generate or import a DID first.');
    if (activeRoom !== TCLK_OFFER_ROOM) throw new Error('Open /r/tclk-offers first.');
    if (!tclkDemo) throw new Error('Post an offer first.');
    if (identity.did !== tclkDemo.payerDid) {
      throw new Error('Restore the payer DID used to start this demo.');
    }
    return tclkDemo;
  }

  async function runTclkDemoAction(progress, action) {
    if (tclkDemoBusy) return;
    tclkDemoBusy = true;
    setTclkDemoNotice(progress);
    refreshTclkDemo();
    try {
      const message = await action();
      setTclkDemoNotice(message, message.startsWith('Demo complete') ? 'success' : '');
    } catch (error) {
      const reason = String(error.message || error).split('\n')[0].slice(0, 220);
      setTclkDemoNotice(`Step failed: ${reason}`, 'error');
    } finally {
      tclkDemoBusy = false;
      refreshTclkDemo();
    }
  }

  async function refreshPaperRecords(analysis, room) {
    const now = Date.now();
    const targets = analysis.deals.filter((deal) => (
      deal.contract && deal.state.rail === 'paper'
    ));
    await Promise.all(targets.map(async (deal) => {
      const fingerprint = `${deal.status}|${deal.latestSeq}`;
      const previous = tclkPaperReads.get(deal.contract);
      if (previous?.fingerprint === fingerprint && now - previous.at < 30_000) return;
      tclkPaperReads.set(deal.contract, { fingerprint, at: now });
      try {
        const result = await readTclkPaperRecord(deal.contract);
        tclkPaperRecords.set(deal.contract, result?.value ?? null);
      } catch (_) {
        tclkPaperRecords.set(deal.contract, { unavailable: true });
      }
    }));
    if (activeRoom === room && tclkAnalysis === analysis) {
      renderTclkDeals(elements.tclkDeals, analysis, tclkPaperRecords);
    }
  }

  function updateTclkViewer() {
    tclkAnalysis = analyzeTclkMessages(roomTranscript);
    elements.tclkSummary.textContent = tclkSummaryText(tclkAnalysis);
    renderTclkDeals(elements.tclkDeals, tclkAnalysis, tclkPaperRecords);
    if (activeRoom) void refreshPaperRecords(tclkAnalysis, activeRoom);
  }

  function applyRoomView(view, { reset = false, advanceCursor = true } = {}) {
    const messages = Array.isArray(view?.messages) ? view.messages : [];
    const previous = roomCursor;
    if (reset) {
      renderedRoomSequences.clear();
      roomTranscript = [];
      tclkPaperRecords.clear();
      tclkPaperReads.clear();
    }
    const freshMessages = messages.filter((message) => {
      const sequence = Number(message?.seq);
      if (!Number.isInteger(sequence) || sequence < 1) return true;
      if (renderedRoomSequences.has(sequence)) return false;
      renderedRoomSequences.add(sequence);
      return true;
    });
    if (reset && !freshMessages.length) showEmptyRoom();
    else if (freshMessages.length) {
      elements.roomLog.querySelector('.room-empty')?.remove();
      renderRoomMessages(elements.roomLog, freshMessages, {
        reset,
        userDid: identity?.did || '',
      });
      applyRoomMessageFilter();
    }
    if (freshMessages.length) roomTranscript.push(...freshMessages);
    if (reset || freshMessages.length) updateTclkViewer();
    if (advanceCursor && previous && messages.length && Number(messages[0].seq) > previous + 1) {
      setRoomState(
        'Connected',
        `History gap detected before sequence ${messages[0].seq}; older records left the room ring.`,
        { active: true, error: true },
      );
    }
    if (advanceCursor) {
      for (const message of messages) updateRoomCursor(message.seq);
      updateRoomCursor(view?.last_seq);
    }
  }

  function waitBeforeRoomRetry(milliseconds, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async function pollRoom(room, controller) {
    while (!controller.signal.aborted && activeRoom === room) {
      try {
        const view = await readTechnocoreRoom(room, {
          since: roomCursor,
          wait: 10,
          signal: controller.signal,
        });
        if (controller.signal.aborted || activeRoom !== room) return;
        applyRoomView(view);
        setRoomState('Connected', `Waiting for signed or unsigned messages in /r/${room}.`, {
          active: true,
        });
      } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        const retry = error.retryAfter ? error.retryAfter * 1000 : 2000;
        const reason = String(error.message || error).split('\n')[0].slice(0, 180);
        setRoomState('Reconnecting', `${reason} Retrying shortly.`, { error: true });
        await waitBeforeRoomRetry(retry, controller.signal);
      }
    }
  }

  async function connectRoom() {
    let room;
    try {
      room = normalizeRoom(elements.chatRoom.value);
    } catch (error) {
      setRoomState('Disconnected', error.message, { error: true });
      return;
    }
    roomAbort?.abort();
    const controller = new AbortController();
    roomAbort = controller;
    activeRoom = room;
    roomCursor = 0;
    renderedRoomSequences.clear();
    roomTranscript = [];
    tclkPaperRecords.clear();
    tclkPaperReads.clear();
    updateTclkViewer();
    elements.roomCursor.textContent = 'Sequence —';
    elements.chatRoom.value = room;
    refreshRoomComposer();
    tclkDemoNotice = null;
    refreshTclkDemo();
    setRoomState('Connecting', `Loading /r/${room} history…`);
    try {
      const historyLimit = room === TCLK_OFFER_ROOM ? 200 : 50;
      const view = await readTechnocoreRoom(room, {
        limit: historyLimit,
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeRoom !== room) return;
      applyRoomView(view, { reset: true });
      setRoomState('Connected', `Waiting for new messages in /r/${room}.`, { active: true });
      void pollRoom(room, controller);
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return;
      activeRoom = '';
      refreshRoomComposer();
      refreshTclkDemo();
      const reason = String(error.message || error).split('\n')[0].slice(0, 180);
      setRoomState('Disconnected', reason, { error: true });
    }
  }

  async function refreshRoomDirectory() {
    buttons.refreshRooms.disabled = true;
    try {
      const view = await listTechnocoreRooms({ limit: 50 });
      const rooms = Array.isArray(view?.rooms) ? view.rooms : [];
      populateRoomOptions(elements.roomSelect, rooms, activeRoom || elements.chatRoom.value);
      setRoomState(
        activeRoom ? 'Connected' : 'Disconnected',
        `Loaded ${rooms.length} of ${Number(view?.total) || rooms.length} public rooms.`,
        { active: Boolean(activeRoom) },
      );
    } catch (error) {
      setRoomState('Disconnected', String(error.message || error).split('\n')[0], { error: true });
    } finally {
      buttons.refreshRooms.disabled = false;
    }
  }

  async function activateSeed(seed, expectedDid = '') {
    elements.identityMessage.textContent = 'Deriving Ed25519 public key…';
    elements.identityMessage.classList.remove('error');
    try {
      const nextIdentity = await createIdentity(seed);
      if (expectedDid && expectedDid !== nextIdentity.did) {
        throw new Error('The DID written in this backup does not match the private seed.');
      }
      identity = nextIdentity;
      elements.seed.value = identity.seed;
      elements.did.value = identity.did;
      elements.identityState.textContent = 'Ready';
      elements.identityState.classList.add('active');
      try {
        saveIdentitySeed(sessionStorage, identity.seed);
        elements.identityMessage.textContent = 'Active for this tab. Download the seed before closing it if you need to restore this DID.';
      } catch (_) {
        elements.identityMessage.textContent = 'DID is active, but this browser blocked local storage.';
      }
      for (const button of [buttons.copyDid, buttons.copySeed, buttons.downloadSeed, buttons.forget]) {
        button.disabled = false;
      }
      refreshRoomComposer();
      tclkDemoNotice = null;
      refreshTclkDemo();
      return true;
    } catch (error) {
      elements.identityMessage.textContent = identity
        ? `${error.message} The current DID is unchanged.`
        : error.message;
      if (identity) elements.seed.value = identity.seed;
      return false;
    }
  }

  async function importSeedFile() {
    const file = elements.seedFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > 8192) throw new Error('The seed backup must be smaller than 8 KiB.');
      const backup = parseIdentityBackup(await file.text());
      const restored = await activateSeed(backup.seed, backup.did);
      if (restored) {
        elements.identityMessage.textContent = backup.did
          ? 'DID restored from file and matched against the backup identity.'
          : 'DID restored from the seed file.';
      }
    } catch (error) {
      elements.identityMessage.textContent = String(error.message || error);
      elements.identityMessage.classList.add('error');
    } finally {
      elements.seedFile.value = '';
    }
  }

  function forgetIdentity() {
    identity = null;
    clearIdentitySeed(localStorage, sessionStorage);
    clearTclkDemoState();
    elements.seed.value = '';
    elements.seed.type = 'password';
    elements.did.value = 'Generate or import a seed to begin';
    elements.identityState.textContent = 'Not connected';
    elements.identityState.classList.remove('active');
    elements.identityMessage.textContent = 'Private key material was removed from this browser.';
    for (const button of [buttons.copyDid, buttons.copySeed, buttons.downloadSeed, buttons.forget]) {
      button.disabled = true;
    }
    refreshRoomComposer();
    refreshTclkDemo();
  }

  async function copyText(value, message, statusElement = elements.identityMessage) {
    try {
      await navigator.clipboard.writeText(value);
      statusElement.textContent = message;
      statusElement.classList.remove('error');
    } catch (_) {
      statusElement.textContent = 'Clipboard access was blocked by the browser.';
      statusElement.classList.add('error');
    }
  }

  function prepareReply(did, sequence) {
    if (!activeRoom || !String(did).startsWith('did:key:')) return;
    const seq = Number(sequence);
    const reference = Number.isSafeInteger(seq) && seq > 0 ? ` re #${seq}` : '';
    const prefix = `@${did}${reference}: `;
    const draft = elements.roomMessage.value.trim();
    elements.roomMessage.value = draft ? `${prefix}${draft}` : prefix;
    refreshRoomComposer({ preserveStatus: true });
    setRoomComposerStatus(
      'Reply prepared with the full DID. Technocore treats mentions as public room text, not private routing.',
    );
    elements.roomMessage.focus();
  }

  function handleContactAction(event) {
    const button = event.target.closest?.('[data-contact-action]');
    if (!button) return;
    const did = String(button.dataset.did || '');
    if (!did.startsWith('did:key:')) return;
    if (button.dataset.contactAction === 'copy-did') {
      void copyText(did, 'Full sender DID copied.', elements.roomComposeStatus);
    } else if (button.dataset.contactAction === 'reply') {
      prepareReply(did, button.dataset.seq);
    }
  }

  function downloadIdentity() {
    if (!identity) return;
    const blob = new Blob([`seed: ${identity.seed}\ndid: ${identity.did}\n`], { type: 'text/plain' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'technocore-seed.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
    elements.identityMessage.textContent = 'Seed file downloaded. Store it securely.';
  }

  async function prepareSignedRoomMessage(signer, room, message) {
    if (!signer?.did) throw new Error('Generate or import a DID first.');
    const nonce = nextTechnocoreNonce(localStorage, TECHNOCORE_ORIGIN, signer.did, room);
    const signed = await signTechnocoreMessage(signer, room, nonce, message);
    saveTechnocoreNonce(
      localStorage,
      TECHNOCORE_ORIGIN,
      signer.did,
      signed.room,
      signed.nonce,
    );
    return signed;
  }

  function prepareRoomMessage(room, message) {
    return prepareSignedRoomMessage(identity, room, message);
  }

  async function postTclkDemoFrame(signer, frame) {
    const signed = await prepareSignedRoomMessage(
      signer,
      TCLK_OFFER_ROOM,
      encodeTclkFrame(frame),
    );
    const view = await postSignedTechnocoreMessage(signed);
    const sequence = Number(view?.posted?.seq);
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new Error('Technocore accepted the frame but returned no posted sequence.');
    }
    if (activeRoom === TCLK_OFFER_ROOM) {
      applyRoomView({ messages: [view.posted] }, { advanceCursor: false });
    }
    return sequence;
  }

  async function postTclkDemoOffer() {
    if (!identity) throw new Error('Generate or import a DID first.');
    if (activeRoom !== TCLK_OFFER_ROOM) throw new Error('Open /r/tclk-offers first.');
    if (!tclkDemo) {
      const asset = elements.tclkDemoAsset.value.trim();
      const amount = elements.tclkDemoAmount.value.trim();
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(asset)) {
        throw new Error('Token name must use 1–32 letters, numbers, underscores, or hyphens.');
      }
      if (!/^[1-9][0-9]{0,23}$/.test(amount)) {
        throw new Error('Amount must be a positive integer with at most 24 digits.');
      }
      const seedBytes = new Uint8Array(32);
      crypto.getRandomValues(seedBytes);
      const payee = await createIdentity(hex(seedBytes));
      tclkDemo = {
        version: 1,
        room: TCLK_OFFER_ROOM,
        payerDid: identity.did,
        payeeDid: payee.did,
        payeeSeed: payee.seed,
        offer: makePaperDemoOffer(identity.did, amount, asset),
        sequences: {},
        paperLocked: false,
        paperClaimed: false,
      };
      saveTclkDemoState();
    }
    const demo = requireTclkDemo();
    if (!demo.sequences.offer) {
      demo.sequences.offer = await postTclkDemoFrame(identity, demo.offer);
      saveTclkDemoState();
    }
    return `Step 1 done: offer posted as #${demo.sequences.offer}.`;
  }

  async function postTclkDemoAccept() {
    const demo = requireTclkDemo();
    if (!demo.sequences.offer) throw new Error('Post the offer first.');
    const payee = await createIdentity(demo.payeeSeed);
    if (payee.did !== demo.payeeDid) throw new Error('The temporary payee seed is inconsistent.');
    if (!demo.accept) {
      const result = makePaperDemoAccept(demo.offer, payee.did);
      demo.accept = result.accept;
      demo.secret = result.secret;
      saveTclkDemoState();
    }
    if (!demo.sequences.accept) {
      demo.sequences.accept = await postTclkDemoFrame(payee, demo.accept);
      saveTclkDemoState();
    }
    return `Step 2 done: accept posted as #${demo.sequences.accept}.`;
  }

  async function postTclkDemoLock() {
    const demo = requireTclkDemo();
    if (!demo.sequences.accept || !demo.accept) throw new Error('Accept the offer first.');
    if (!demo.lock) {
      demo.lock = makePaperDemoLock(demo.accept, demo.payerDid);
      saveTclkDemoState();
    }
    if (!demo.paperLocked) {
      const result = await writeTclkPaperLock(
        demo.accept.contract,
        demo.accept.statement,
        demo.offer.refundAfterMs,
      );
      demo.paperLocked = true;
      tclkPaperRecords.set(demo.accept.contract, result.value);
      tclkPaperReads.delete(demo.accept.contract);
      saveTclkDemoState();
    }
    if (!demo.sequences.lock) {
      demo.sequences.lock = await postTclkDemoFrame(identity, demo.lock);
      saveTclkDemoState();
    }
    updateTclkViewer();
    return `Step 3 done: PAPER locked and frame posted as #${demo.sequences.lock}.`;
  }

  async function postTclkDemoReveal() {
    const demo = requireTclkDemo();
    if (!demo.sequences.lock || !demo.paperLocked) throw new Error('Lock PAPER first.');
    if (!demo.accept || !demo.secret) throw new Error('The temporary payee secret is missing.');
    const payee = await createIdentity(demo.payeeSeed);
    if (payee.did !== demo.payeeDid) throw new Error('The temporary payee seed is inconsistent.');
    if (!demo.reveal) {
      demo.reveal = makePaperDemoReveal(demo.accept, payee.did, demo.secret);
      saveTclkDemoState();
    }
    if (!demo.sequences.reveal) {
      demo.sequences.reveal = await postTclkDemoFrame(payee, demo.reveal);
      saveTclkDemoState();
    }
    if (!demo.paperClaimed) {
      const result = await claimTclkPaperRecord(demo.accept.contract, demo.secret);
      demo.paperClaimed = true;
      tclkPaperRecords.set(demo.accept.contract, result.value);
      tclkPaperReads.delete(demo.accept.contract);
      saveTclkDemoState();
    }
    updateTclkViewer();
    return `Step 4 done: reveal posted as #${demo.sequences.reveal} and PAPER claimed.`;
  }

  async function postTclkDemoReceipt() {
    const demo = requireTclkDemo();
    if (!demo.sequences.reveal || !demo.paperClaimed) throw new Error('Reveal and claim PAPER first.');
    if (!demo.receipt) {
      demo.receipt = makePaperDemoReceipt(demo.accept, demo.payerDid);
      saveTclkDemoState();
    }
    if (!demo.sequences.receipt) {
      demo.sequences.receipt = await postTclkDemoFrame(identity, demo.receipt);
      saveTclkDemoState();
    }
    return `Demo complete: receipt posted as #${demo.sequences.receipt}.`;
  }

  async function sendRoomMessage() {
    if (!identity || !activeRoom || roomPosting) return;
    const room = activeRoom;
    const draft = elements.roomMessage.value;
    roomPosting = true;
    refreshRoomComposer({ preserveStatus: true });
    setRoomComposerStatus(`Signing and sending to /r/${room}…`);
    try {
      const signed = await prepareRoomMessage(room, draft);
      const view = await postSignedTechnocoreMessage(signed);
      const sequence = Number(view?.posted?.seq);
      if (!Number.isInteger(sequence) || sequence < 1) {
        throw new Error('Technocore accepted the request but returned no posted sequence.');
      }
      if (activeRoom === room) {
        // Render the acknowledged write immediately, but let the long poll advance the
        // cursor so messages posted just before ours cannot be skipped.
        applyRoomView({ messages: [view.posted] }, { advanceCursor: false });
      }
      if (elements.roomMessage.value === draft) elements.roomMessage.value = '';
      setRoomComposerStatus(`Sent as sequence #${sequence} in /r/${room}.`);
    } catch (error) {
      const reason = String(error.message || error).split('\n')[0].slice(0, 180);
      setRoomComposerStatus(`Send failed: ${reason}`, { error: true });
    } finally {
      roomPosting = false;
      refreshRoomComposer({ preserveStatus: true });
      elements.roomMessage.focus();
    }
  }

  function currentTickers() {
    return symbols.map((symbol) => tickers.get(symbol)).filter(Boolean);
  }

  function addAgentMessage(role, text, reusable = false) {
    const message = document.createElement('div');
    message.className = `agent-message ${role}`;
    const meta = document.createElement('p');
    meta.className = 'agent-message-meta';
    meta.textContent = role === 'user' ? 'You' : 'Browser Agent';
    const bubble = document.createElement('p');
    bubble.className = 'agent-bubble';
    bubble.textContent = text;
    message.append(meta, bubble);
    elements.agentLog.appendChild(message);
    while (elements.agentLog.children.length > 80) elements.agentLog.firstElementChild.remove();
    elements.agentLog.scrollTop = elements.agentLog.scrollHeight;
    if (role === 'agent' && reusable) {
      latestAgentAnswer = text;
      buttons.useAgentAnswer.disabled = false;
    }
  }

  function askAgent(question) {
    const value = question.trim();
    if (!value) return;
    addAgentMessage('user', value);
    const answer = answerCryptoQuery(value, currentTickers());
    addAgentMessage('agent', answer.text, answer.intent !== 'waiting' && answer.intent !== 'help');
  }

  function updateReportStatus() {
    if (!nextReportAt) {
      elements.reportStatus.textContent = 'Reports run only while this page remains open.';
      return;
    }
    const seconds = Math.max(0, Math.ceil((nextReportAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    elements.reportStatus.textContent = `Next report in ${minutes}:${String(remainder).padStart(2, '0')} · page must stay open.`;
  }

  function configureReports() {
    clearInterval(reportTimer);
    clearInterval(reportCountdown);
    nextReportAt = 0;
    const minutes = Number(elements.reportInterval.value);
    if (!minutes) {
      updateReportStatus();
      return;
    }
    const delay = minutes * 60 * 1000;
    nextReportAt = Date.now() + delay;
    updateReportStatus();
    reportCountdown = setInterval(updateReportStatus, 1000);
    reportTimer = setInterval(() => {
      addAgentMessage('agent', buildPeriodicReport(currentTickers()), true);
      nextReportAt = Date.now() + delay;
      updateReportStatus();
    }, delay);
    addAgentMessage('agent', `Automatic reports are on every ${minutes} minutes. They run only while this page is open.`);
  }

  document.getElementById('generate-did').addEventListener('click', () => {
    if (identity && !window.confirm('Create a new DID? This replaces the identity saved in this browser. Download the current seed first if you need it.')) return;
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    activateSeed(hex(seed));
  });
  document.getElementById('import-seed').addEventListener('click', () => activateSeed(elements.seed.value.trim()));
  buttons.importSeedFile.addEventListener('click', () => elements.seedFile.click());
  elements.seedFile.addEventListener('change', () => void importSeedFile());
  elements.seed.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') activateSeed(elements.seed.value.trim());
  });
  document.getElementById('toggle-seed').addEventListener('click', (event) => {
    const reveal = elements.seed.type === 'password';
    elements.seed.type = reveal ? 'text' : 'password';
    event.currentTarget.textContent = reveal ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} private seed`);
  });
  buttons.copyDid.addEventListener('click', () => identity && copyText(identity.did, 'DID copied.'));
  buttons.copySeed.addEventListener('click', () => identity && copyText(identity.seed, 'Private seed copied. Keep it secret.'));
  buttons.downloadSeed.addEventListener('click', downloadIdentity);
  buttons.forget.addEventListener('click', forgetIdentity);

  document.getElementById('symbol-form').addEventListener('submit', (event) => {
    event.preventDefault();
    elements.marketMessage.textContent = '';
    try {
      const symbol = normalizeSymbol(elements.symbol.value);
      if (symbols.includes(symbol)) throw new Error(`${symbol} is already in your watchlist.`);
      if (symbols.length >= MAX_SYMBOLS) throw new Error(`The watchlist supports up to ${MAX_SYMBOLS} markets.`);
      symbols.push(symbol);
      elements.symbol.value = '';
      marketChanged();
    } catch (error) {
      elements.marketMessage.textContent = error.message;
    }
  });
  document.getElementById('refresh').addEventListener('click', refreshMarket);
  buttons.refreshRooms.addEventListener('click', refreshRoomDirectory);
  buttons.connectRoom.addEventListener('click', connectRoom);
  elements.roomSelect.addEventListener('change', () => {
    if (!elements.roomSelect.value) return;
    elements.chatRoom.value = elements.roomSelect.value;
  });
  elements.chatRoom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connectRoom();
  });
  document.getElementById('agent-form').addEventListener('submit', (event) => {
    event.preventDefault();
    askAgent(elements.agentQuestion.value);
    elements.agentQuestion.value = '';
  });
  document.querySelectorAll('[data-agent-prompt]').forEach((button) => {
    button.addEventListener('click', () => askAgent(button.dataset.agentPrompt));
  });
  elements.reportInterval.addEventListener('change', configureReports);
  buttons.useAgentAnswer.addEventListener('click', () => {
    elements.roomMessage.value = latestAgentAnswer;
    refreshRoomComposer();
    elements.roomMessage.focus();
  });
  elements.roomMessage.addEventListener('input', () => {
    refreshRoomComposer({ preserveStatus: true });
  });
  elements.roomComposer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendRoomMessage();
  });
  elements.roomMessage.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    elements.roomComposer.requestSubmit();
  });
  elements.roomMessageFilter.addEventListener('change', applyRoomMessageFilter);
  elements.roomLog.addEventListener('click', handleContactAction);
  elements.tclkDeals.addEventListener('click', handleContactAction);
  buttons.tclkDemoConnect.addEventListener('click', () => {
    elements.chatRoom.value = TCLK_OFFER_ROOM;
    void connectRoom();
  });
  buttons.tclkDemoReset.addEventListener('click', () => {
    if (tclkDemo && Object.keys(tclkDemo.sequences || {}).length
        && !window.confirm('Start a new local demo? Public frames and PAPER notes already written cannot be removed.')) return;
    clearTclkDemoState();
    refreshTclkDemo();
  });
  buttons.tclkDemoOffer.addEventListener('click', () => {
    void runTclkDemoAction('Creating the temporary payee and posting the offer…', postTclkDemoOffer);
  });
  buttons.tclkDemoAccept.addEventListener('click', () => {
    void runTclkDemoAction('Minting the hash secret and posting the acceptance…', postTclkDemoAccept);
  });
  buttons.tclkDemoLock.addEventListener('click', () => {
    void runTclkDemoAction('Writing the PAPER lock and posting its frame…', postTclkDemoLock);
  });
  buttons.tclkDemoReveal.addEventListener('click', () => {
    void runTclkDemoAction('Posting the reveal and claiming the PAPER note…', postTclkDemoReveal);
  });
  buttons.tclkDemoReceipt.addEventListener('click', () => {
    void runTclkDemoAction('Posting the terminal receipt…', postTclkDemoReceipt);
  });

  renderMarket();
  addAgentMessage('agent', 'Hello. I track the live Binance data in your watchlist. Try “BTC price” or “Top losers”.');
  refreshRoomComposer();
  updateTclkViewer();
  refreshTclkDemo();
  const savedSeed = loadIdentitySeed(localStorage, sessionStorage);
  if (savedSeed) {
    elements.identityMessage.textContent = 'Restoring saved DID…';
    activateSeed(savedSeed);
  }
  refreshMarket();
  connectStream();
  refreshRoomDirectory();
  window.addEventListener('pagehide', () => roomAbort?.abort());
}

if (typeof document !== 'undefined') startApp();
