/**
 * server/polymarket-api.js
 *
 * All Polymarket API calls — Gamma + Data + CLOB v2
 *
 * NETWORK FIX:
 *   node-fetch v2 uses timeout option correctly.
 *   node-fetch v3 is ESM-only — we use v2 (commonjs).
 *   Added: AbortController timeout, retry on network errors,
 *          DNS check on startup, clear error messages.
 */

const fetch   = require('node-fetch');
const { ethers } = require('ethers');
const crypto  = require('crypto');
const https   = require('https');
const dns     = require('dns');
const { promisify } = require('util');
const dnsResolve = promisify(dns.resolve4);

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA  = 'https://data-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

/** Gamma filters markets by numeric tag_id; ?tag=slug is ignored — map UI slugs → API slugs */
const TAG_SLUG_ALIASES = {
  tech: 'technology',
  culture: 'pop-culture',
  economy: 'economics',
  cricket: 'cricket',
};

let _tagsSlugToId = null;
let _tagsFetchedAt = 0;
const TAG_CACHE_MS = 3600000;

async function resolveTagId(tagSlug) {
  if (!tagSlug || typeof tagSlug !== 'string') return null;
  const raw = tagSlug.trim().toLowerCase();
  const trySlug = TAG_SLUG_ALIASES[raw] || raw;

  const now = Date.now();
  if (!_tagsSlugToId || now - _tagsFetchedAt > TAG_CACHE_MS) {
    const d = await apiFetch(`${GAMMA}/tags?limit=2000`);
    const arr = Array.isArray(d) ? d : (d?.data || []);
    _tagsSlugToId = new Map();
    for (const t of arr) {
      const slug = (t.slug || '').toLowerCase();
      const id   = t.id;
      if (slug && id != null) _tagsSlugToId.set(slug, id);
    }
    _tagsFetchedAt = now;
  }

  let id = _tagsSlugToId.get(trySlug);
  if (id == null && trySlug !== raw) id = _tagsSlugToId.get(raw);
  return id != null ? id : null;
}

function parseJsonArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseOutcomePriceArray(m) {
  const op = parseJsonArray(m.outcomePrices);
  return op.map(x => parseFloat(x)).filter(n => Number.isFinite(n));
}

/** Gamma returns outcomes / clobTokenIds as JSON strings — build token rows for pricing + CLOB */
function buildTokensFromGamma(m) {
  if (Array.isArray(m.tokens) && m.tokens.length) return m.tokens;
  const labels  = parseJsonArray(m.outcomes).map(x => String(x));
  const prices  = parseJsonArray(m.outcomePrices).map(x => parseFloat(x));
  const tokIds  = parseJsonArray(m.clobTokenIds).map(x => String(x));
  const n       = Math.max(labels.length, tokIds.length, prices.length);
  const tokens  = [];
  for (let i = 0; i < n; i++) {
    tokens.push({
      outcome: labels[i] || `Outcome ${i}`,
      price:   Number.isFinite(prices[i]) ? prices[i] : NaN,
      tokenId: tokIds[i] || null,
    });
  }
  return tokens;
}

function eventToCtx(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const img = ev.image || ev.featuredImage || ev.icon || null;
  return {
    image:    img,
    icon:     ev.icon || null,
    category: ev.category || null,
    tags:     ev.tags,
    eventSlug: ev.slug || null,
    eventTitle: ev.title || null,
  };
}

async function fetchPublicProfile(address) {
  if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) return null;
  const url = `${GAMMA}/public-profile?address=${encodeURIComponent(address)}`;
  return apiFetch(url, { allow404: true });
}

/** Polymarket indexes positions/activity by proxy wallet; resolve from profile + positions */
async function resolveDataUser(signerAddr) {
  const a = (signerAddr || '').toLowerCase();
  const prof = await fetchPublicProfile(signerAddr).catch(() => null);
  const fromProfile =
    prof?.proxyWallet && /^0x[a-fA-F0-9]{40}$/i.test(prof.proxyWallet) ? prof.proxyWallet : null;

  const rows = await apiFetch(`${DATA}/positions?user=${encodeURIComponent(signerAddr)}&sizeThreshold=0.001&limit=30`);
  const list = Array.isArray(rows) ? rows : [];
  const fromPos =
    list[0]?.proxyWallet && /^0x[a-fA-F0-9]{40}$/i.test(list[0].proxyWallet) ? list[0].proxyWallet : null;

  for (const c of [fromProfile, fromPos]) {
    if (c && c.toLowerCase() !== a) return c;
  }
  return signerAddr;
}

const CTF_EXCHANGE  = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_DECIMALS = 6;

/** Polymarket collateral (pUSD) on Polygon — see https://docs.polymarket.com/resources/contracts */
const DEFAULT_COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

const ERC20_MIN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

let _polygonRpcOk = null;

function collateralTokenAddress() {
  const a = (process.env.POLYGON_COLLATERAL_TOKEN || DEFAULT_COLLATERAL).trim();
  return /^0x[a-fA-F0-9]{40}$/i.test(a) ? a : DEFAULT_COLLATERAL;
}

function getPolygonRpcStatus() {
  return _polygonRpcOk;
}

async function checkPolygonRpc() {
  const url = (process.env.POLYGON_RPC_URL || '').trim();
  if (!url) {
    _polygonRpcOk = null;
    console.warn('[Chain] POLYGON_RPC_URL not set — collateral balance uses API only (often $0)');
    return null;
  }
  try {
    const p = new ethers.JsonRpcProvider(url);
    await p.getBlockNumber();
    _polygonRpcOk = true;
    console.log('✅ Polygon RPC: OK (on-chain pUSD balance enabled)');
    return true;
  } catch (e) {
    _polygonRpcOk = false;
    console.warn('[Chain] Polygon RPC unreachable:', e.message);
    return false;
  }
}

/**
 * Tradable collateral (pUSD) balance for the Polymarket proxy / wallet address.
 * Requires POLYGON_RPC_URL in .env.
 */
async function getCollateralBalance(walletAddress) {
  const rpc = (process.env.POLYGON_RPC_URL || '').trim();
  if (!rpc || !walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) return null;
  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const token    = new ethers.Contract(collateralTokenAddress(), ERC20_MIN_ABI, provider);
    const [raw, dec] = await Promise.all([
      token.balanceOf(walletAddress),
      token.decimals().catch(() => 6),
    ]);
    return parseFloat(ethers.formatUnits(raw, Number(dec)));
  } catch (e) {
    console.warn('[Chain] balanceOf failed:', e.message);
    return null;
  }
}

async function getIntegrationHealth() {
  const [tags, dataPing, clobTime] = await Promise.all([
    apiFetch(`${GAMMA}/tags?limit=1`),
    apiFetch(`${DATA}/`),
    apiFetch(`${CLOB}/time`),
  ]);
  return {
    gamma:           !!tags,
    dataApi:         dataPing != null,
    clob:            clobTime != null,
    polygonRpc:      _polygonRpcOk,
    collateralToken: collateralTokenAddress(),
  };
}

async function getGammaTags(limit = 500) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  const d   = await apiFetch(`${GAMMA}/tags?limit=${lim}`);
  return Array.isArray(d) ? d : [];
}

/** CLOB v2 public reads — all trading still goes through placeTrade + wallet */
async function clobTokenPrice(tokenId, side = 'buy') {
  if (!tokenId) return null;
  const s = /^sell/i.test(String(side)) ? 'SELL' : 'BUY';
  return apiFetch(`${CLOB}/price?token_id=${encodeURIComponent(tokenId)}&side=${s}`);
}

async function clobMidpoint(tokenId) {
  if (!tokenId) return null;
  return apiFetch(`${CLOB}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
}

async function clobSpread(tokenId) {
  if (!tokenId) return null;
  return apiFetch(`${CLOB}/spread?token_id=${encodeURIComponent(tokenId)}`);
}

async function clobOrderBook(tokenId) {
  if (!tokenId) return null;
  return apiFetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}

// ── DNS / connectivity check (run at startup) ─────────────
let _networkOk = null;   // null = not checked yet
async function checkNetwork() {
  try {
    await dnsResolve('gamma-api.polymarket.com');
    await dnsResolve('data-api.polymarket.com');
    _networkOk = true;
    console.log('✅ Network: Polymarket APIs reachable');
  } catch (e) {
    _networkOk = false;
    console.error('❌ Network: Cannot reach Polymarket APIs —', e.message);
    console.error('   This usually means:');
    console.error('   1. No internet connection on this machine');
    console.error('   2. DNS is blocked (try: nslookup gamma-api.polymarket.com)');
    console.error('   3. Firewall blocking outbound HTTPS');
    console.error('   4. VPN required in your region');
    console.error('   Fix: check internet, try a different DNS (8.8.8.8), or use a VPN');
  }
  return _networkOk;
}

function getNetworkStatus() { return _networkOk; }

// ── Generic fetch with retry ──────────────────────────────
// Uses AbortController for real timeout (works in Node 18+)
async function apiFetch(url, opts = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutMs  = opts.timeoutMs || 15000;
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, {
        method: opts.method || 'GET',
        body:   opts.body,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          'User-Agent':   'polymarket-bot/1.0',
          ...(opts.headers || {}),
        },
      });
      clearTimeout(timer);

      if (!r.ok) {
        if (opts.allow404 && r.status === 404) return null;
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      return await r.json();

    } catch (e) {
      clearTimeout(timer);
      const isRetryable = e.name === 'AbortError' ||
                          e.message.includes('ECONNRESET') ||
                          e.message.includes('ETIMEDOUT') ||
                          e.message.includes('ECONNREFUSED');

      if (attempt < retries && isRetryable) {
        console.warn(`[API] Retry ${attempt + 1}/${retries}: ${url.replace(/https:\/\/[^/]+/, '…')}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));  // backoff
        continue;
      }

      // Final failure — log clearly
      const shortUrl = url.replace(/https:\/\/[^/]+/, '…').split('?')[0];
      if (e.name === 'AbortError') {
        console.warn(`[API] Timeout (${timeoutMs}ms): ${shortUrl}`);
      } else if (e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo')) {
        console.error(`[API] DNS failure — cannot reach ${url.split('/')[2]}`);
        console.error(`      Check internet connection or try: nslookup ${url.split('/')[2]}`);
      } else {
        console.warn(`[API] ${shortUrl} → ${e.message}`);
      }
      return null;
    }
  }
  return null;
}

// ── HMAC-SHA256 for CLOB v2 auth headers ─────────────────
function hmac(secret, msg) {
  return crypto.createHmac('sha256', secret).update(msg).digest('base64');
}

// ── Build CLOB auth headers ────────────────────────────────
async function clobHeaders(creds, method, path, body = '') {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const sig = hmac(creds.secret, ts + method.toUpperCase() + path + body);
  return {
    'POLY_ADDRESS':    creds.address,
    'POLY_TIMESTAMP':  ts,
    'POLY_API_KEY':    creds.key,
    'POLY_SIGNATURE':  sig,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}


// ── Generate CLOB API credentials from wallet ─────────────
async function generateClobCreds(wallet) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = 0;

  const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
  const types  = {
    ClobAuth: [
      { name: 'address',   type: 'address' },
      { name: 'timestamp', type: 'string'  },
      { name: 'nonce',     type: 'uint256' },
      { name: 'message',   type: 'string'  },
    ],
  };
  const value = {
    address:   wallet.address,
    timestamp: ts,
    nonce,
    message:   'This message attests that I control the given wallet',
  };

  const sig = await wallet.signTypedData(domain, types, value);

  try {
    const resp = await apiFetch(`${CLOB}/auth/api-key`, {
      method: 'POST',
      body: JSON.stringify({ address: wallet.address, signature: sig, timestamp: ts, nonce }),
    });
    if (resp?.apiKey) {
      return { key: resp.apiKey, secret: resp.secret, passphrase: resp.passphrase, address: wallet.address };
    }
  } catch (e) {
    console.warn('[Auth] CLOB key exchange failed, using derived creds');
  }

  // Fallback: deterministic derivation from signature
  const h = ethers.keccak256(ethers.toUtf8Bytes(sig + wallet.address));
  return { key: h.slice(2,34), secret: h.slice(34,66), passphrase: h.slice(0,18), address: wallet.address, derived: true };
}

// ══════════════════════════════════════════════════════════
// USER DATA
// ══════════════════════════════════════════════════════════

async function getProfile(address) {
  const p = await fetchPublicProfile(address);
  if (!p) {
    return {
      address,
      username: null,
      avatar: null,
      bio: null,
      cashBalance: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalVolume: 0,
      tradesCount: 0,
      tradingAddress: address,
    };
  }
  const username =
    p.name ||
    p.pseudonym ||
    p.username ||
    (p.xUsername && String(p.xUsername)) ||
    null;
  return {
    address,
    tradingAddress: p.proxyWallet || address,
    username,
    avatar:        p.profileImage || null,
    bio:           p.bio || null,
    cashBalance:   safeNum(p.cashBalance ?? p.usdcBalance, 0),
    realizedPnl:   safeNum(p.realizedPnl, 0),
    unrealizedPnl: safeNum(p.unrealizedPnl, 0),
    totalVolume:   safeNum(p.volume ?? p.totalVolume, 0),
    tradesCount:   parseInt(p.tradesCount || p.numTrades || 0, 10) || 0,
  };
}

function safeNum(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

async function getPositions(address) {
  const d = await apiFetch(`${DATA}/positions?user=${address}&sizeThreshold=0.001&limit=100`);
  const list = Array.isArray(d) ? d : (d?.data || []);
  return list.map(p => ({
    conditionId:   p.conditionId || p.market,
    title:         p.title || p.marketTitle || p.question || 'Unknown',
    outcome:       p.outcome,
    size:          safeNum(p.size, 0),
    avgPrice:      safeNum(p.avgPrice ?? p.averagePrice, 0),
    currentPrice:  safeNum(p.currentPrice ?? p.curPrice ?? p.price, 0),
    pnl:           safeNum(p.cashPnl ?? p.unrealizedPnl ?? p.pnl, 0),
    currentValue:  safeNum(p.currentValue, 0),
    endDate:       p.endDate || null,
  })).filter(p => p.size > 0.001);
}

async function getTrades(address, limit = 100) {
  const addr = (address || '').toLowerCase();
  const d = await apiFetch(`${DATA}/activity?user=${encodeURIComponent(address)}&limit=${limit}`);
  const la = d ? (Array.isArray(d) ? d : (d.data || d.results || [])) : [];

  const rows = la.filter(t => {
    const u = (t.user || t.proxyWallet || t.makerAddress || '').toLowerCase();
    if (!u) return true;
    return u === addr;
  });

  const seen = new Set();
  return rows
    .filter(t => {
      const id = t.id || t.tradeId || t.transactionHash || JSON.stringify(t).slice(0, 48);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(t => ({
      id:        t.id || t.tradeId,
      market:    t.market || t.conditionId,
      title:     t.title || t.marketTitle || t.question || 'Unknown',
      outcome:   t.outcome,
      side:      t.side,
      price:     safeNum(t.price, 0),
      size:      safeNum(t.size, 0),
      usdcValue: safeNum(t.usdcValue ?? t.amount ?? (t.price && t.size ? t.price * t.size : 0), 0),
      timestamp: t.timestamp || t.createdAt,
      txHash:    t.transactionHash || null,
    }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function getPortfolio(signerAddress) {
  const dataUser = await resolveDataUser(signerAddress);
  const [gammaProf, pos, trades, chainCollateral] = await Promise.all([
    (async () => {
      let p = await fetchPublicProfile(signerAddress);
      if (dataUser.toLowerCase() !== signerAddress.toLowerCase()) {
        const p2 = await fetchPublicProfile(dataUser);
        if (p2) p = p2;
      }
      return p;
    })(),
    getPositions(dataUser).catch(() => []),
    getTrades(dataUser, 30).catch(() => []),
    getCollateralBalance(dataUser).catch(() => null),
  ]);

  const username =
    gammaProf?.name ||
    gammaProf?.pseudonym ||
    gammaProf?.username ||
    (gammaProf?.xUsername && String(gammaProf.xUsername)) ||
    null;

  const realizedFromPos = pos.reduce((s, p) => s + safeNum(p.realizedPnl, 0), 0);
  const unrealFromPos   = pos.reduce((s, p) => s + safeNum(p.cashPnl ?? p.pnl, 0), 0);
  const gammaCash       = safeNum(gammaProf?.cashBalance ?? gammaProf?.usdcBalance, 0);
  const useChain        = chainCollateral != null && Number.isFinite(chainCollateral);
  const cashBalance     = useChain ? chainCollateral : gammaCash;

  return {
    address:           signerAddress,
    tradingAddress:    dataUser,
    polymarketProfileAddress: dataUser,
    username,
    avatar:            gammaProf?.profileImage || null,
    bio:               gammaProf?.bio || null,
    cashBalance,
    cashBalanceSource: useChain ? 'chain' : 'gamma',
    collateralToken:  collateralTokenAddress(),
    realizedPnl:       safeNum(gammaProf?.realizedPnl, realizedFromPos) || realizedFromPos,
    unrealizedPnl:     safeNum(gammaProf?.unrealizedPnl, unrealFromPos) || unrealFromPos,
    totalVolume:       safeNum(gammaProf?.volume ?? gammaProf?.totalVolume, 0),
    tradesCount:       parseInt(gammaProf?.tradesCount || gammaProf?.numTrades || 0, 10) || trades.length,
    positions:         pos,
    recentTrades:      trades,
    posCount:          pos.length,
    posValue:          pos.reduce(
      (s, p) => s + safeNum(p.currentValue, safeNum(p.size, 0) * safeNum(p.currentPrice, 0)),
      0,
    ),
  };
}

// ══════════════════════════════════════════════════════════
// MARKETS
// ══════════════════════════════════════════════════════════

async function getMarkets({ limit = 30, tag, search } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const q   = search && String(search).trim();

  if (q) {
    const perType = Math.min(50, lim);
    const d = await apiFetch(
      `${GAMMA}/public-search?q=${encodeURIComponent(q)}&events_status=active&limit_per_type=${perType}`,
    );
    const out   = [];
    const seen  = new Set();
    const pushM = (raw, ev) => {
      const nm = normMarket(raw, eventToCtx(ev));
      if (!nm.id || !nm.title || seen.has(nm.id)) return;
      if (raw.closed || raw.archived) return;
      seen.add(nm.id);
      out.push(nm);
    };
    const evs = Array.isArray(d?.events) ? d.events : [];
    for (const ev of evs) {
      for (const m of ev.markets || []) pushM(m, ev);
    }
    const mk = Array.isArray(d?.markets) ? d.markets : [];
    for (const m of mk) pushM(m, null);
    return out.slice(0, lim);
  }

  let tagQS = '';
  if (tag) {
    const tagId = await resolveTagId(tag);
    if (tagId != null) tagQS = `&tag_id=${tagId}&related_tags=true`;
    else console.warn(`[Markets] Unknown tag slug "${tag}" — returning unfiltered events`);
  }

  const eventLimit = Math.min(100, Math.max(lim * 2, 40));
  let url = `${GAMMA}/events?active=true&closed=false&limit=${eventLimit}&offset=0&order=volume_24hr&ascending=false${tagQS}`;
  let events = await apiFetch(url);
  if (!events) {
    url = `${GAMMA}/events?active=true&closed=false&limit=${eventLimit}&offset=0&order=volume24hr&ascending=false${tagQS}`;
    events = await apiFetch(url);
  }
  const arr = Array.isArray(events) ? events : [];
  const out = [];
  const seen = new Set();
  for (const ev of arr) {
    const evCtx = eventToCtx(ev);
    for (const m of ev.markets || []) {
      if (m.closed || m.archived) continue;
      const nm = normMarket(m, evCtx);
      if (!nm.id || !nm.title || seen.has(nm.id)) continue;
      seen.add(nm.id);
      out.push(nm);
      if (out.length >= lim) return out;
    }
  }
  return out;
}

async function getMarket(cid) {
  if (!cid) return null;
  let d = await apiFetch(`${GAMMA}/markets/${encodeURIComponent(cid)}`);
  if (!d) {
    const arr = await apiFetch(`${GAMMA}/markets?condition_ids=${encodeURIComponent(cid)}&limit=1`);
    const list = Array.isArray(arr) ? arr : [];
    d = list[0] || null;
  }
  return d ? normMarket(d) : null;
}

async function searchMarkets(q, limit = 8) {
  return getMarkets({ limit, search: q });
}

function normMarket(m, eventCtx) {
  const tokens = buildTokensFromGamma(m);
  const yT = tokens.find(t => /yes/i.test(t.outcome)) || tokens[0] || {};
  const nT = tokens.find(t => /no/i.test(t.outcome))  || tokens[1] || {};
  const opArr = parseOutcomePriceArray(m);

  let yP = parseFloat(yT.price);
  if (!Number.isFinite(yP) && opArr.length >= 1) yP = opArr[0];
  if (!Number.isFinite(yP) && m.outcomePrices != null) {
    const raw = parseJsonArray(m.outcomePrices)[0];
    yP = parseFloat(raw);
  }
  if (!Number.isFinite(yP) || yP < 0 || yP > 1) yP = 0.5;

  let nP = parseFloat(nT.price);
  if (!Number.isFinite(nP) && opArr.length >= 2) nP = opArr[1];
  if (!Number.isFinite(nP) || nP < 0 || nP > 1) nP = Math.max(0, Math.min(1, 1 - yP));

  const vol24 = safeNum(m.volume24hr ?? m.volume24hNum ?? m.volume24hrClob, 0);
  const liq   = safeNum(m.liquidityNum ?? m.liquidity ?? m.liquidityClob, 0);
  const vol   = safeNum(m.volumeNum ?? m.volume ?? m.volumeClob, 0);

  const tagLabels = (m.tags || []).map(t => (typeof t === 'object' ? (t.label || t.slug) : t)).filter(Boolean);
  const evTags    = (eventCtx?.tags || []).map(t => (typeof t === 'object' ? (t.label || t.slug) : t)).filter(Boolean);
  const mergedTags = [...new Set([...tagLabels, ...evTags])];

  const img =
    m.image ||
    m.icon ||
    m.twitterCardImage ||
    eventCtx?.image ||
    eventCtx?.icon ||
    null;

  return {
    id:          m.conditionId || m.id,
    slug:        m.slug,
    title:       m.question || m.title || eventCtx?.eventTitle,
    description: m.description,
    category:    m.category || eventCtx?.category || (mergedTags[0]) || 'General',
    tags:        mergedTags.length ? mergedTags : tagLabels,
    image:       img,
    endDate:     m.endDateIso || m.endDate,
    yesPrice:    yP,
    noPrice:     nP,
    yesPct:      Math.round(yP * 100),
    noPct:       Math.round(nP * 100),
    volume:      vol,
    volume24h:   vol24,
    liquidity:   liq,
    yesTokenId:  yT.tokenId || parseJsonArray(m.clobTokenIds)[0],
    noTokenId:   nT.tokenId || parseJsonArray(m.clobTokenIds)[1],
    conditionId: m.conditionId,
    spread:      Math.abs(yP + nP - 1),
    outcomes:    tokens.map(t => ({
      label:   t.outcome,
      price:   safeNum(t.price, 0),
      tokenId: t.tokenId,
    })),
  };
}

// ══════════════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════════════

async function getLeaderboard(limit = 25) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 50);
  const url = `${DATA}/v1/leaderboard?timePeriod=ALL&orderBy=PNL&limit=${lim}`;
  const d   = await apiFetch(url);
  const raw = Array.isArray(d) ? d : [];
  const list = raw.filter(t => t && t.proxyWallet);
  return list.map((t, i) => {
    const addr = t.proxyWallet;
    const nm   = t.userName || (addr ? addr.slice(0, 8) + '…' : 'Trader');
    return {
      rank:    parseInt(t.rank, 10) || i + 1,
      address: addr,
      name:    nm,
      avatar:  t.profileImage || null,
      profit:  safeNum(t.pnl, 0),
      roi:     0,
      volume:  safeNum(t.vol, 0),
      trades:  0,
      winRate: 0,
    };
  });
}

async function getUserValue(userAddress) {
  if (!userAddress) return null;
  return apiFetch(`${DATA}/value?user=${encodeURIComponent(userAddress)}`);
}

async function getTraderActivity(address, limit = 20) {
  const d = await apiFetch(`${DATA}/activity?user=${address}&limit=${limit}`);
  return (Array.isArray(d) ? d : (d?.data || [])).map(t => ({
    market:    t.market || t.conditionId,
    title:     t.title || t.marketTitle || t.question || 'Unknown',
    outcome:   t.outcome,
    side:      t.side,
    price:     parseFloat(t.price || 0),
    size:      parseFloat(t.size || 0),
    timestamp: t.timestamp || t.createdAt,
  }));
}

// ══════════════════════════════════════════════════════════
// TRADE EXECUTION — CLOB v2 (server-side, signed with private key)
// ══════════════════════════════════════════════════════════

/**
 * placeTrade — Signs and submits an order via Polymarket CLOB v2
 * Called server-side using the wallet private key from .env
 */
async function placeTrade({ wallet, creds, marketId, outcome, side = 'buy', amount }) {
  const market = await getMarket(marketId);
  if (!market) throw new Error(`Market not found: ${marketId}`);

  const isYes = /yes/i.test(outcome);
  const tok   = market.outcomes?.find(o => isYes ? /yes/i.test(o.label) : /no/i.test(o.label))
              || market.outcomes?.[isYes ? 0 : 1];
  if (!tok?.tokenId) throw new Error(`No tokenId found for ${outcome}`);

  const price    = isYes ? market.yesPrice : market.noPrice;
  const isBuy    = /buy/i.test(side);
  const DEC      = 10 ** USDC_DECIMALS;
  const salt     = BigInt(Date.now() * 1000 + Math.floor(Math.random() * 999));
  const expire   = BigInt(Math.floor(Date.now() / 1000) + 7200);
  const makerAmt = isBuy ? BigInt(Math.floor(amount * DEC)) : BigInt(Math.floor((amount / price) * DEC));
  const takerAmt = isBuy ? BigInt(Math.floor((amount / price) * DEC)) : BigInt(Math.floor(amount * DEC));

  const order = {
    salt:          salt.toString(),
    maker:         wallet.address,
    signer:        wallet.address,
    taker:        '0x0000000000000000000000000000000000000000',
    tokenId:       tok.tokenId.toString(),
    makerAmount:   makerAmt.toString(),
    takerAmount:   takerAmt.toString(),
    expiration:    expire.toString(),
    nonce:        '0',
    feeRateBps:   '0',
    side:          isBuy ? 0 : 1,
    signatureType: 0,
  };

  // Sign with private key (server-side, no MetaMask needed)
  const domain = { name: 'CTFExchange', version: '1', chainId: 137, verifyingContract: CTF_EXCHANGE };
  const types  = {
    Order: [
      { name: 'salt',          type: 'uint256' },{ name: 'maker',         type: 'address' },
      { name: 'signer',        type: 'address' },{ name: 'taker',         type: 'address' },
      { name: 'tokenId',       type: 'uint256' },{ name: 'makerAmount',   type: 'uint256' },
      { name: 'takerAmount',   type: 'uint256' },{ name: 'expiration',    type: 'uint256' },
      { name: 'nonce',         type: 'uint256' },{ name: 'feeRateBps',    type: 'uint256' },
      { name: 'side',          type: 'uint8'   },{ name: 'signatureType', type: 'uint8'   },
    ],
  };

  const sig = await wallet.signTypedData(domain, types, order);

  // Submit to CLOB v2
  let result = null;
  try {
    const body    = JSON.stringify({ order, signature: sig, owner: wallet.address, orderType: 'GTC' });
    const headers = await clobHeaders(creds, 'POST', '/order', body);
    result = await apiFetch(`${CLOB}/order`, { method: 'POST', headers, body });
  } catch (e) {
    console.warn('[Trade] CLOB submit failed:', e.message);
  }

  return {
    success:   true,
    simulated: !result || !!result?.error,
    orderId:   result?.orderID || result?.id || `SIG_${Date.now()}`,
    market:    market.title,
    marketId,
    slug:      market.slug,
    outcome:   outcome.toUpperCase(),
    side:      isBuy ? 'buy' : 'sell',
    amount,
    price,
    status:    result?.status || (result ? 'submitted' : 'signed_pending_funds'),
    note:      !result ? 'Signed but needs USDC + contract approval to execute on-chain' : null,
  };
}

module.exports = {
  checkNetwork, getNetworkStatus,
  checkPolygonRpc, getPolygonRpcStatus,
  generateClobCreds,
  getProfile, getPositions, getTrades, getPortfolio,
  getMarkets, getMarket, searchMarkets,
  getLeaderboard, getTraderActivity, getUserValue,
  getCollateralBalance, getIntegrationHealth, collateralTokenAddress,
  getGammaTags,
  clobTokenPrice, clobMidpoint, clobSpread, clobOrderBook,
  placeTrade,
};
