export const API_URL = 'https://api.binance.com/api/v3/ticker/24hr';
export const STREAM_URL = 'wss://stream.binance.com:9443/stream?streams=';
export const WATCHLIST_KEY = 'signal-id-watchlist-v1';
export const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
export const MAX_SYMBOLS = 8;

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
    const aliases = [
      ...(ASSET_ALIASES[asset] || [asset.toLowerCase()]),
      ticker.symbol.toLowerCase(),
    ];
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
  return `${ticker.symbol.slice(0, -4)}: ${formatPrice(ticker.price)} · `
    + `${percent(ticker.change)} (24h)`;
}

export function answerCryptoQuery(question, values) {
  const tickers = availableTickers(values);
  if (!tickers.length) {
    return {
      intent: 'waiting',
      text: 'I am waiting for Binance data. Try again in a few seconds.',
    };
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
      return {
        intent: 'compare',
        text: 'Name at least two coins from the watchlist, for example: “Compare BTC and ETH”.',
      };
    }
    const ranked = [...selected].sort((left, right) => right.change - left.change);
    const lead = ranked[0];
    return {
      intent: 'compare',
      text: `${selected.map(tickerLine).join('\n')}\n${lead.symbol.slice(0, -4)} `
        + 'has the best 24h performance in this group.',
    };
  }

  if (/(coin nao|which|top|dang giam|giam manh|loser|worst|falling|\bdown\b)/.test(folded)
      && /(giam|loser|worst|falling|\bdown\b)/.test(folded)) {
    const falling = tickers.filter((ticker) => ticker.change < 0)
      .sort((left, right) => left.change - right.change);
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
      return `${ticker.symbol.slice(0, -4)}: low ${formatPrice(ticker.low)} · `
        + `high ${formatPrice(ticker.high)} · range ${spread.toFixed(2)}%`;
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
  if (!tickers.length) return 'Binance data is not available yet.';
  const ranked = [...tickers].sort((left, right) => right.change - left.change);
  const rising = tickers.filter((ticker) => ticker.change >= 0).length;
  const falling = tickers.length - rising;
  const time = new Date(now).toLocaleTimeString(
    'en-US', { hour: '2-digit', minute: '2-digit' },
  );
  return [
    `Automated report at ${time}`,
    `Best performer: ${tickerLine(ranked[0])}`,
    `Weakest performer: ${tickerLine(ranked[ranked.length - 1])}`,
    `Watchlist: ${rising} up/flat · ${falling} down`,
    '',
    ...tickers.map(tickerLine),
  ].join('\n');
}
