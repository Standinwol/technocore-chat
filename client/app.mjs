import {
  clearIdentitySeed,
  createIdentity,
  hex,
  loadIdentitySeed,
  loadIdentityVault,
  removeIdentityFromVault,
  saveIdentitySeed,
  saveIdentityToVault,
  unlockIdentityFromVault,
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
  buildSignedMessageUrl,
  listTechnocoreRooms,
  nextTechnocoreNonce,
  normalizeRoom,
  postSignedTechnocoreMessage,
  readTechnocoreRoom,
  saveTechnocoreNonce,
  signTechnocoreMessage,
} from './technocore.mjs';
import { populateRoomOptions, renderRoomMessages } from './room-ui.mjs';

export {
  canonicalSnapshot,
  clearIdentitySeed,
  createIdentity,
  loadIdentitySeed,
  loadIdentityVault,
  removeIdentityFromVault,
  saveIdentityToVault,
  saveIdentitySeed,
  signSnapshot,
  unlockIdentityFromVault,
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
    vaultState: document.getElementById('vault-state'),
    vaultIdentities: document.getElementById('vault-identities'),
    identityLabel: document.getElementById('identity-label'),
    vaultPassphrase: document.getElementById('vault-passphrase'),
    vaultMessage: document.getElementById('vault-message'),
    hostState: document.getElementById('host-state'),
    hostDid: document.getElementById('host-did'),
    hostMessage: document.getElementById('host-message'),
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
    technocoreOrigin: document.getElementById('technocore-origin'),
    technocoreRoom: document.getElementById('technocore-room'),
    technocoreMessage: document.getElementById('technocore-message'),
    technocoreNonce: document.getElementById('technocore-nonce'),
    technocoreSignature: document.getElementById('technocore-signature'),
    signedUrl: document.getElementById('signed-url'),
    publishStatus: document.getElementById('publish-status'),
  };
  const buttons = {
    copyDid: document.getElementById('copy-did'),
    copySeed: document.getElementById('copy-seed'),
    downloadSeed: document.getElementById('download-seed'),
    forget: document.getElementById('forget-did'),
    saveVault: document.getElementById('save-vault'),
    unlockVault: document.getElementById('unlock-vault'),
    removeVault: document.getElementById('remove-vault'),
    useAgentAnswer: document.getElementById('use-agent-answer'),
    refreshRooms: document.getElementById('refresh-rooms'),
    connectRoom: document.getElementById('connect-room'),
    signTechnocore: document.getElementById('sign-technocore'),
    postTechnocore: document.getElementById('post-technocore'),
    copySignedUrl: document.getElementById('copy-signed-url'),
    openSignedUrl: document.getElementById('open-signed-url'),
  };
  let identity = null;
  let hostDid = '';
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

  function applyRoomView(view, { reset = false } = {}) {
    const messages = Array.isArray(view?.messages) ? view.messages : [];
    const previous = roomCursor;
    if (reset && !messages.length) showEmptyRoom();
    else renderRoomMessages(elements.roomLog, messages, { reset, hostDid });
    if (previous && messages.length && Number(messages[0].seq) > previous + 1) {
      setRoomState(
        'Connected',
        `History gap detected before sequence ${messages[0].seq}; older records left the room ring.`,
        { active: true, error: true },
      );
    }
    for (const message of messages) updateRoomCursor(message.seq);
    updateRoomCursor(view?.last_seq);
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
    elements.roomCursor.textContent = 'Sequence —';
    elements.chatRoom.value = room;
    elements.technocoreRoom.value = room;
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

  function refreshVaultOptions(preferredDid = identity?.did || '') {
    const vault = loadIdentityVault(localStorage);
    elements.vaultIdentities.textContent = '';
    if (!vault.identities.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'No encrypted identities';
      elements.vaultIdentities.appendChild(empty);
    } else {
      for (const record of vault.identities) {
        const option = document.createElement('option');
        option.value = record.did;
        option.textContent = `${record.label} — ${record.did.slice(8, 14)}…${record.did.slice(-6)}`;
        if (record.did === preferredDid || (!preferredDid && record.did === vault.activeDid)) {
          option.selected = true;
        }
        elements.vaultIdentities.appendChild(option);
      }
    }
    const hasSaved = Boolean(elements.vaultIdentities.value);
    elements.vaultState.textContent = vault.identities.length
      ? `${vault.identities.length} saved`
      : 'Empty';
    elements.vaultState.classList.toggle('active', vault.identities.length > 0);
    buttons.unlockVault.disabled = !hasSaved;
    buttons.removeVault.disabled = !hasSaved;
    buttons.saveVault.disabled = !identity;
  }

  async function saveActiveIdentityToVault() {
    if (!identity) return;
    buttons.saveVault.disabled = true;
    elements.vaultMessage.textContent = 'Encrypting identity…';
    try {
      const record = await saveIdentityToVault(
        localStorage,
        identity,
        elements.vaultPassphrase.value,
        elements.identityLabel.value,
      );
      clearIdentitySeed(localStorage);
      elements.vaultPassphrase.value = '';
      refreshVaultOptions(record.did);
      elements.vaultMessage.textContent = `${record.label} was encrypted and saved in this browser.`;
      elements.identityMessage.textContent = 'Active for this tab and protected by the encrypted vault after refresh.';
    } catch (error) {
      elements.vaultMessage.textContent = error.message;
    } finally {
      buttons.saveVault.disabled = !identity;
    }
  }

  async function unlockSelectedIdentity() {
    const did = elements.vaultIdentities.value;
    if (!did) return;
    buttons.unlockVault.disabled = true;
    elements.vaultMessage.textContent = 'Unlocking identity…';
    try {
      const unlocked = await unlockIdentityFromVault(
        localStorage, did, elements.vaultPassphrase.value,
      );
      await activateSeed(unlocked.seed);
      elements.vaultPassphrase.value = '';
      refreshVaultOptions(unlocked.did);
      elements.vaultMessage.textContent = 'Encrypted identity unlocked for this tab.';
    } catch (error) {
      elements.vaultMessage.textContent = error.message;
    } finally {
      buttons.unlockVault.disabled = !elements.vaultIdentities.value;
    }
  }

  function removeSelectedVaultIdentity() {
    const did = elements.vaultIdentities.value;
    if (!did) return;
    if (!window.confirm('Delete this encrypted identity from this browser? Export its seed first if you need it.')) {
      return;
    }
    removeIdentityFromVault(localStorage, did);
    refreshVaultOptions();
    elements.vaultMessage.textContent = 'Encrypted identity deleted from this browser.';
  }

  async function loadHostIdentity() {
    try {
      const response = await fetch('/api/host', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Host API returned HTTP ${response.status}`);
      const value = await response.json();
      if (!value.configured || !/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(value.did || '')) {
        throw new Error('Configure HOST_DID after the VPS Host identity is created.');
      }
      hostDid = value.did;
      elements.hostDid.value = hostDid;
      elements.hostState.textContent = 'Configured';
      elements.hostState.classList.add('active');
      elements.hostMessage.textContent = `${value.name || 'Signal ID Host'} responses are highlighted only when signed by this DID.`;
    } catch (error) {
      hostDid = '';
      elements.hostState.textContent = 'Not configured';
      elements.hostState.classList.remove('active');
      elements.hostMessage.textContent = error.message;
    }
  }

  async function activateSeed(seed) {
    elements.identityMessage.textContent = 'Deriving Ed25519 public key…';
    try {
      const nextIdentity = await createIdentity(seed);
      identity = nextIdentity;
      invalidateSignedMessage();
      elements.seed.value = identity.seed;
      elements.did.value = identity.did;
      elements.identityState.textContent = 'Ready';
      elements.identityState.classList.add('active');
      try {
        saveIdentitySeed(sessionStorage, identity.seed);
        elements.identityMessage.textContent = 'Active for this tab. Save it encrypted to restore it after refresh.';
      } catch (_) {
        elements.identityMessage.textContent = 'DID is active, but this browser blocked local storage.';
      }
      for (const button of [buttons.copyDid, buttons.copySeed, buttons.downloadSeed, buttons.forget,
        buttons.signTechnocore, buttons.postTechnocore]) {
        button.disabled = false;
      }
      buttons.saveVault.disabled = false;
      refreshVaultOptions(identity.did);
      elements.publishStatus.textContent = 'DID ready. Write and sign a message.';
      elements.publishStatus.classList.remove('error');
    } catch (error) {
      elements.identityMessage.textContent = identity
        ? `${error.message} The current DID is unchanged.`
        : error.message;
      if (identity) elements.seed.value = identity.seed;
    }
  }

  function forgetIdentity() {
    const did = identity?.did || '';
    const saved = loadIdentityVault(localStorage).identities.some((record) => record.did === did);
    if (saved && !window.confirm('Remove the active DID and its encrypted vault copy from this browser?')) {
      return;
    }
    if (did) removeIdentityFromVault(localStorage, did);
    identity = null;
    clearIdentitySeed(localStorage, sessionStorage);
    elements.seed.value = '';
    elements.seed.type = 'password';
    elements.did.value = 'Generate or import a seed to begin';
    elements.identityState.textContent = 'Not connected';
    elements.identityState.classList.remove('active');
    elements.identityMessage.textContent = 'Private key material was removed from this browser.';
    for (const button of [buttons.copyDid, buttons.copySeed, buttons.downloadSeed, buttons.forget,
      buttons.signTechnocore, buttons.postTechnocore, buttons.copySignedUrl,
      buttons.openSignedUrl]) button.disabled = true;
    buttons.saveVault.disabled = true;
    elements.technocoreNonce.value = '';
    elements.technocoreSignature.value = '';
    elements.signedUrl.value = '';
    elements.publishStatus.textContent = 'Private key material was removed from this browser.';
    refreshVaultOptions();
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

  function invalidateSignedMessage() {
    elements.technocoreNonce.value = '';
    elements.technocoreSignature.value = '';
    elements.signedUrl.value = '';
    buttons.copySignedUrl.disabled = true;
    buttons.openSignedUrl.disabled = true;
    if (identity) elements.publishStatus.textContent = 'Message changed. Sign it to generate a new URL.';
  }

  async function prepareSignedMessage() {
    if (!identity) throw new Error('Generate or import a DID first.');
    const origin = elements.technocoreOrigin.value;
    const room = normalizeRoom(elements.technocoreRoom.value);
    const nonce = nextTechnocoreNonce(localStorage, origin, identity.did, room);
    const signed = await signTechnocoreMessage(
      identity, room, nonce, elements.technocoreMessage.value,
    );
    const url = buildSignedMessageUrl(origin, signed);
    saveTechnocoreNonce(localStorage, origin, identity.did, room, signed.nonce);
    elements.technocoreRoom.value = signed.room;
    elements.chatRoom.value = signed.room;
    elements.technocoreMessage.value = signed.text;
    elements.technocoreNonce.value = signed.nonce;
    elements.technocoreSignature.value = signed.sig;
    elements.signedUrl.value = url;
    return { signed, url };
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
  buttons.saveVault.addEventListener('click', saveActiveIdentityToVault);
  buttons.unlockVault.addEventListener('click', unlockSelectedIdentity);
  buttons.removeVault.addEventListener('click', removeSelectedVaultIdentity);
  elements.vaultIdentities.addEventListener('change', () => {
    const selected = loadIdentityVault(localStorage).identities
      .find((record) => record.did === elements.vaultIdentities.value);
    if (selected) elements.identityLabel.value = selected.label;
  });

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
    elements.technocoreRoom.value = elements.roomSelect.value;
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
    elements.technocoreMessage.value = latestAgentAnswer;
    invalidateSignedMessage();
    elements.technocoreMessage.focus();
  });
  for (const input of [elements.technocoreOrigin, elements.technocoreRoom, elements.technocoreMessage]) {
    input.addEventListener('input', invalidateSignedMessage);
  }
  buttons.signTechnocore.addEventListener('click', async () => {
    if (!identity) return;
    try {
      await prepareSignedMessage();
      buttons.copySignedUrl.disabled = false;
      buttons.openSignedUrl.disabled = false;
      elements.publishStatus.textContent = 'Message signed. Copy or open the URL to publish it.';
      elements.publishStatus.classList.remove('error');
    } catch (error) {
      elements.publishStatus.textContent = `Signing failed: ${error.message}`;
      elements.publishStatus.classList.add('error');
    }
  });
  buttons.postTechnocore.addEventListener('click', async () => {
    if (!identity) return;
    buttons.postTechnocore.disabled = true;
    elements.publishStatus.textContent = 'Signing and posting…';
    elements.publishStatus.classList.remove('error');
    try {
      const { signed } = await prepareSignedMessage();
      const view = await postSignedTechnocoreMessage(signed);
      const sequence = Number(view?.posted?.seq);
      if (!Number.isInteger(sequence) || sequence < 1) {
        throw new Error('Technocore accepted the request but returned no posted sequence.');
      }
      buttons.copySignedUrl.disabled = true;
      buttons.openSignedUrl.disabled = true;
      elements.signedUrl.value = '';
      elements.publishStatus.textContent = `Posted as sequence #${sequence} by ${identity.did}.`;
    } catch (error) {
      buttons.copySignedUrl.disabled = !elements.signedUrl.value;
      buttons.openSignedUrl.disabled = !elements.signedUrl.value;
      elements.publishStatus.textContent = `Post failed: ${String(error.message || error).split('\n')[0]}`;
      elements.publishStatus.classList.add('error');
    } finally {
      buttons.postTechnocore.disabled = false;
    }
  });
  buttons.copySignedUrl.addEventListener('click', () => {
    if (elements.signedUrl.value) copyText(elements.signedUrl.value, 'Signed URL copied.', elements.publishStatus);
  });
  buttons.openSignedUrl.addEventListener('click', () => {
    if (!elements.signedUrl.value) return;
    const opened = window.open(elements.signedUrl.value, '_blank', 'noopener,noreferrer');
    if (!opened) {
      elements.publishStatus.textContent = 'The browser blocked the new tab. Allow popups or copy the signed URL.';
      elements.publishStatus.classList.add('error');
      return;
    }
    elements.signedUrl.value = '';
    buttons.copySignedUrl.disabled = true;
    buttons.openSignedUrl.disabled = true;
    elements.publishStatus.textContent = 'Opened Technocore in a new tab. Read the number in [brackets] to get your sequence.';
    elements.publishStatus.classList.remove('error');
  });

  renderMarket();
  refreshVaultOptions();
  loadHostIdentity();
  addAgentMessage('agent', 'Hello. I track the live Binance data in your watchlist. Try “BTC price” or “Top losers”.');
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
