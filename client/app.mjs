import {
  clearIdentitySeed,
  createIdentity,
  hex,
  loadIdentitySeed,
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
  listTechnocoreRooms,
  nextTechnocoreNonce,
  normalizeRoom,
  postSignedTechnocoreMessage,
  readTechnocoreRoom,
  saveTechnocoreNonce,
  signTechnocoreMessage,
} from './technocore.mjs';
import { populateRoomOptions, renderRoomMessages } from './room-ui.mjs';

const TECHNOCORE_ORIGIN = 'https://technocore.chat';

export {
  canonicalSnapshot,
  clearIdentitySeed,
  createIdentity,
  loadIdentitySeed,
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
  listTechnocoreRooms,
  normalizeTechnocoreOrigin,
  normalizeRoom,
  postSignedTechnocoreMessage,
  readTechnocoreRoom,
  signTechnocoreMessage,
} from './technocore.mjs';

function startApp() {
  const elements = {
    seed: document.getElementById('seed'),
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
  };
  const buttons = {
    copyDid: document.getElementById('copy-did'),
    copySeed: document.getElementById('copy-seed'),
    downloadSeed: document.getElementById('download-seed'),
    forget: document.getElementById('forget-did'),
    useAgentAnswer: document.getElementById('use-agent-answer'),
    refreshRooms: document.getElementById('refresh-rooms'),
    connectRoom: document.getElementById('connect-room'),
    sendRoomMessage: document.getElementById('send-room-message'),
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
  const renderedRoomSequences = new Set();

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

  function applyRoomView(view, { reset = false, advanceCursor = true } = {}) {
    const messages = Array.isArray(view?.messages) ? view.messages : [];
    const previous = roomCursor;
    if (reset) renderedRoomSequences.clear();
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
    }
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
    elements.roomCursor.textContent = 'Sequence —';
    elements.chatRoom.value = room;
    refreshRoomComposer();
    setRoomState('Connecting', `Loading /r/${room} history…`);
    try {
      const view = await readTechnocoreRoom(room, { limit: 50, signal: controller.signal });
      if (controller.signal.aborted || activeRoom !== room) return;
      applyRoomView(view, { reset: true });
      setRoomState('Connected', `Waiting for new messages in /r/${room}.`, { active: true });
      void pollRoom(room, controller);
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return;
      activeRoom = '';
      refreshRoomComposer();
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

  async function activateSeed(seed) {
    elements.identityMessage.textContent = 'Deriving Ed25519 public key…';
    try {
      const nextIdentity = await createIdentity(seed);
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
    } catch (error) {
      elements.identityMessage.textContent = identity
        ? `${error.message} The current DID is unchanged.`
        : error.message;
      if (identity) elements.seed.value = identity.seed;
    }
  }

  function forgetIdentity() {
    identity = null;
    clearIdentitySeed(localStorage, sessionStorage);
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

  async function prepareRoomMessage(room, message) {
    if (!identity) throw new Error('Generate or import a DID first.');
    const nonce = nextTechnocoreNonce(localStorage, TECHNOCORE_ORIGIN, identity.did, room);
    const signed = await signTechnocoreMessage(identity, room, nonce, message);
    saveTechnocoreNonce(
      localStorage,
      TECHNOCORE_ORIGIN,
      identity.did,
      signed.room,
      signed.nonce,
    );
    return signed;
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

  renderMarket();
  addAgentMessage('agent', 'Hello. I track the live Binance data in your watchlist. Try “BTC price” or “Top losers”.');
  refreshRoomComposer();
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
