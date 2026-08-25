const API_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const STREAM_URL = 'wss://stream.binance.com:9443/stream?streams=';
const WATCHLIST_KEY = 'signal-id-watchlist-v1';
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const MAX_SYMBOLS = 8;
const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

export function normalizeSymbol(value) {
  let symbol = String(value || '').trim().toUpperCase().replace(/[\s/_-]/g, '');
  if (!symbol) throw new Error('Enter an asset such as BTC or ETH.');
  if (!symbol.endsWith('USDT')) symbol += 'USDT';
  if (!/^[A-Z0-9]{5,16}$/.test(symbol) || symbol === 'USDT') {
    throw new Error('Use a valid USDT market such as BTCUSDT.');
  }
  return symbol;
}

export function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const digits = number >= 1000 ? 2 : number >= 1 ? 4 : number >= 0.01 ? 6 : 8;
  return '$' + number.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function tickerFromRest(value) {
  return {
    symbol: value.symbol,
    price: Number(value.lastPrice),
    change: Number(value.priceChangePercent),
    high: Number(value.highPrice),
    low: Number(value.lowPrice),
    volume: Number(value.quoteVolume),
    timestamp: Number(value.closeTime),
  };
}

export function tickerFromStream(value) {
  return {
    symbol: value.s,
    price: Number(value.c),
    change: Number(value.P),
    high: Number(value.h),
    low: Number(value.l),
    volume: Number(value.q),
    timestamp: Number(value.E),
  };
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function unhex(value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('The private seed must be exactly 64 hexadecimal characters.');
  }
  return new Uint8Array(value.match(/../g).map((pair) => parseInt(pair, 16)));
}

function base64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  if (typeof atob === 'function') return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new Uint8Array(Buffer.from(padded, 'base64'));
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
  if (!cryptoApi?.subtle) throw new Error('Web Crypto is unavailable. Open this app over HTTPS or localhost.');
  const seed = unhex(seedHex);
  const encoded = new Uint8Array(PKCS8_ED25519.length + seed.length);
  encoded.set(PKCS8_ED25519);
  encoded.set(seed, PKCS8_ED25519.length);
  const key = await cryptoApi.subtle.importKey('pkcs8', encoded, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await cryptoApi.subtle.exportKey('jwk', key);
  const publicBytes = base64url(jwk.x);
  const tagged = new Uint8Array(publicBytes.length + 2);
  tagged.set([0xed, 0x01]);
  tagged.set(publicBytes, 2);
  const verifyKey = await cryptoApi.subtle.importKey('raw', publicBytes, { name: 'Ed25519' }, true, ['verify']);
  return {
    did: 'did:key:z' + base58(tagged),
    seed: hex(seed),
    key,
    verifyKey,
  };
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

export async function signSnapshot(identity, tickers, createdAt = Date.now(), cryptoApi = globalThis.crypto) {
  const payload = canonicalSnapshot(identity.did, tickers, createdAt);
  const signature = await cryptoApi.subtle.sign(
    'Ed25519', identity.key, new TextEncoder().encode(payload),
  );
  return JSON.stringify({ payload: JSON.parse(payload), signature: hex(new Uint8Array(signature)) }, null, 2);
}

const ASSET_ALIASES = {
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ethereum', 'ether'],
  BNB: ['bnb', 'binance coin'],
  SOL: ['sol', 'solana'],
  XRP: ['xrp', 'ripple'],
  DOGE: ['doge', 'dogecoin'],
  ADA: ['ada', 'cardano'],
};

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function availableTickers(values) {
  return [...values].filter((ticker) => ticker
    && ticker.symbol?.endsWith('USDT')
    && Number.isFinite(ticker.price)
    && Number.isFinite(ticker.change));
}

function mentionedTickers(question, tickers) {
  const folded = foldText(question);
  return tickers.filter((ticker) => {
    const asset = ticker.symbol.slice(0, -4);
    const aliases = [...(ASSET_ALIASES[asset] || [asset.toLowerCase()]), ticker.symbol.toLowerCase()];
    return aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(folded);
    });
  });
}

function percent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function tickerLine(ticker) {
  return `${ticker.symbol.slice(0, -4)}: ${formatPrice(ticker.price)} · ${percent(ticker.change)} (24h)`;
}

export function answerCryptoQuery(question, values) {
  const tickers = availableTickers(values);
  if (!tickers.length) {
    return { intent: 'waiting', text: 'I am waiting for Binance data. Try again in a few seconds.' };
  }
  const folded = foldText(question).trim();
  const selected = mentionedTickers(question, tickers);
  const help = [
    'I answer directly from your live Binance watchlist. Try asking:',
    '• BTC price',
    '• Top gainers or Top losers',
    '• Compare BTC and ETH',
    '• 24h range',
    '• Which coins are falling?',
  ].join('\n');

  if (!folded || /^(help|tro giup|xin chao|chao|hello|hi)$/.test(folded)) {
    return { intent: 'help', text: help };
  }

  if (/(so sanh|compare|\bvs\b)/.test(folded)) {
    if (selected.length < 2) {
      return { intent: 'compare', text: 'Name at least two coins from the watchlist, for example: “Compare BTC and ETH”.' };
    }
    const ranked = [...selected].sort((left, right) => right.change - left.change);
    const lead = ranked[0];
    return {
      intent: 'compare',
      text: `${selected.map(tickerLine).join('\n')}\n${lead.symbol.slice(0, -4)} has the best 24h performance in this group.`,
    };
  }

  if (/(coin nao|which|top|dang giam|giam manh|loser|worst|falling|\bdown\b)/.test(folded)
      && /(giam|loser|worst|falling|\bdown\b)/.test(folded)) {
    const falling = tickers.filter((ticker) => ticker.change < 0).sort((left, right) => left.change - right.change);
    return {
      intent: 'losers',
      text: falling.length
        ? `Coins falling in the watchlist:\n${falling.map(tickerLine).join('\n')}`
        : 'No coin in the watchlist is down over the current 24h window.',
    };
  }

  if (/(top|tang manh|gainer|best|rising|\bup\b)/.test(folded)
      && /(tang|gainer|best|rising|\bup\b)/.test(folded)) {
    const rising = tickers.filter((ticker) => ticker.change >= 0)
      .sort((left, right) => right.change - left.change)
      .slice(0, 3);
    return {
      intent: 'gainers',
      text: rising.length
        ? `Top 24h gainers in the watchlist:\n${rising.map(tickerLine).join('\n')}`
        : 'No coin in the watchlist is up over the current 24h window.',
    };
  }

  if (/(bien dong|24 ?h|range|cao nhat|thap nhat)/.test(folded)) {
    const targets = selected.length ? selected : tickers;
    const lines = targets.map((ticker) => {
      const spread = ticker.low > 0 ? ((ticker.high - ticker.low) / ticker.low) * 100 : 0;
      return `${ticker.symbol.slice(0, -4)}: low ${formatPrice(ticker.low)} · high ${formatPrice(ticker.high)} · range ${spread.toFixed(2)}%`;
    });
    return { intent: 'range', text: `24h range:\n${lines.join('\n')}` };
  }

  if (/(gia|price|bao nhieu)/.test(folded) || selected.length) {
    const targets = selected.length ? selected : tickers;
    return { intent: 'price', text: targets.map(tickerLine).join('\n') };
  }

  return { intent: 'help', text: help };
}

export function buildPeriodicReport(values, now = Date.now()) {
  const tickers = availableTickers(values);
  if (!tickers.length) return 'Chưa có dữ liệu Binance để lập báo cáo.';
  const ranked = [...tickers].sort((left, right) => right.change - left.change);
  const rising = tickers.filter((ticker) => ticker.change >= 0).length;
  const falling = tickers.length - rising;
  const time = new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return [
    `Automated report at ${time}`,
    `Best performer: ${tickerLine(ranked[0])}`,
    `Weakest performer: ${tickerLine(ranked[ranked.length - 1])}`,
    `Watchlist: ${rising} up/flat · ${falling} down`,
    '',
    ...tickers.map(tickerLine),
  ].join('\n');
}

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
    snapshot: document.getElementById('snapshot-output'),
    agentLog: document.getElementById('agent-log'),
    agentQuestion: document.getElementById('agent-question'),
    reportInterval: document.getElementById('report-interval'),
    reportStatus: document.getElementById('report-status'),
  };
  const buttons = {
    copyDid: document.getElementById('copy-did'),
    copySeed: document.getElementById('copy-seed'),
    forget: document.getElementById('forget-did'),
    sign: document.getElementById('sign-snapshot'),
    copySnapshot: document.getElementById('copy-snapshot'),
  };
  let identity = null;
  let tickers = new Map();
  let socket = null;
  let streamGeneration = 0;
  let reconnectTimer = null;
  let signedSnapshot = '';
  let reportTimer = null;
  let nextReportAt = 0;
  let reportCountdown = null;

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
      buttons.sign.disabled = true;
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
    buttons.sign.disabled = !identity || !symbols.some((symbol) => tickers.has(symbol));
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

  async function activateSeed(seed) {
    elements.identityMessage.textContent = 'Deriving Ed25519 public key…';
    try {
      identity = await createIdentity(seed);
      elements.seed.value = identity.seed;
      elements.did.value = identity.did;
      elements.identityState.textContent = 'Ready';
      elements.identityState.classList.add('active');
      elements.identityMessage.textContent = 'Ready to sign price snapshots locally.';
      for (const button of [buttons.copyDid, buttons.copySeed, buttons.forget]) button.disabled = false;
      buttons.sign.disabled = !symbols.some((symbol) => tickers.has(symbol));
    } catch (error) {
      identity = null;
      elements.identityMessage.textContent = error.message;
    }
  }

  function forgetIdentity() {
    identity = null;
    elements.seed.value = '';
    elements.seed.type = 'password';
    elements.did.value = 'Generate or import a seed to begin';
    elements.identityState.textContent = 'Not connected';
    elements.identityState.classList.remove('active');
    elements.identityMessage.textContent = 'Private key material was removed from this tab.';
    for (const button of [buttons.copyDid, buttons.copySeed, buttons.forget, buttons.sign]) button.disabled = true;
  }

  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      elements.identityMessage.textContent = message;
    } catch (_) {
      elements.identityMessage.textContent = 'Clipboard access was blocked by the browser.';
    }
  }

  function currentTickers() {
    return symbols.map((symbol) => tickers.get(symbol)).filter(Boolean);
  }

  function addAgentMessage(role, text) {
    const message = document.createElement('div');
    message.className = `agent-message ${role}`;
    const meta = document.createElement('p');
    meta.className = 'agent-message-meta';
    meta.textContent = role === 'user' ? 'You' : 'Technocore Agent';
    const bubble = document.createElement('p');
    bubble.className = 'agent-bubble';
    bubble.textContent = text;
    message.append(meta, bubble);
    elements.agentLog.appendChild(message);
    while (elements.agentLog.children.length > 80) elements.agentLog.firstElementChild.remove();
    elements.agentLog.scrollTop = elements.agentLog.scrollHeight;
  }

  function askAgent(question) {
    const value = question.trim();
    if (!value) return;
    addAgentMessage('user', value);
    const answer = answerCryptoQuery(value, currentTickers());
    addAgentMessage('agent', answer.text);
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
      addAgentMessage('agent', buildPeriodicReport(currentTickers()));
      nextReportAt = Date.now() + delay;
      updateReportStatus();
    }, delay);
    addAgentMessage('agent', `Automatic reports are on every ${minutes} minutes. They run only while this page is open.`);
  }

  document.getElementById('generate-did').addEventListener('click', () => {
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
  document.getElementById('agent-form').addEventListener('submit', (event) => {
    event.preventDefault();
    askAgent(elements.agentQuestion.value);
    elements.agentQuestion.value = '';
  });
  document.querySelectorAll('[data-agent-prompt]').forEach((button) => {
    button.addEventListener('click', () => askAgent(button.dataset.agentPrompt));
  });
  elements.reportInterval.addEventListener('change', configureReports);
  buttons.sign.addEventListener('click', async () => {
    if (!identity) return;
    const values = symbols.map((symbol) => tickers.get(symbol)).filter(Boolean);
    try {
      signedSnapshot = await signSnapshot(identity, values);
      elements.snapshot.textContent = signedSnapshot;
      buttons.copySnapshot.disabled = false;
    } catch (error) {
      elements.snapshot.textContent = `Signing failed: ${error.message}`;
    }
  });
  buttons.copySnapshot.addEventListener('click', () => signedSnapshot && copyText(signedSnapshot, 'Signed snapshot JSON copied.'));

  renderMarket();
  addAgentMessage('agent', 'Hello. I am a rule-based agent: no OpenAI, and every answer comes from the Binance data in your watchlist. Try “BTC price” or “Top losers”.');
  refreshMarket();
  connectStream();
}

if (typeof document !== 'undefined') startApp();
