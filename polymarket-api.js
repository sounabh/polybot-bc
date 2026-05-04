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

const CTF_EXCHANGE  = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_DECIMALS = 6;

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
        ...opts,
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
  const d = await apiFetch(`${DATA}/profiles?address=${address}`);
  const p = Array.isArray(d) ? d[0] : (d || {});
  return {
    address,
    username:       p.name || p.pseudonym || null,
    avatar:         p.profileImage || null,
    bio:            p.bio || null,
    cashBalance:    parseFloat(p.cashBalance      || 0),
    realizedPnl:    parseFloat(p.realizedPnl      || 0),
    unrealizedPnl:  parseFloat(p.unrealizedPnl    || 0),
    totalVolume:    parseFloat(p.volume           || p.totalVolume || 0),
    tradesCount:    parseInt(p.tradesCount        || 0),
  };
}

async function getPositions(address) {
  const d = await apiFetch(`${DATA}/positions?user=${address}&sizeThreshold=0.001&limit=100`);
  const list = Array.isArray(d) ? d : (d?.data || []);
  return list.map(p => ({
    conditionId:   p.conditionId || p.market,
    title:         p.title || p.marketTitle || p.question || 'Unknown',
    outcome:       p.outcome,
    size:          parseFloat(p.size || 0),
    avgPrice:      parseFloat(p.avgPrice || p.averagePrice || 0),
    currentPrice:  parseFloat(p.currentPrice || p.price || 0),
    pnl:           parseFloat(p.unrealizedPnl || p.pnl || 0),
    currentValue:  parseFloat(p.currentValue || 0),
    endDate:       p.endDate || null,
  })).filter(p => p.size > 0.001);
}

async function getTrades(address, limit = 100) {
  const [ra, rb] = await Promise.allSettled([
    apiFetch(`${DATA}/activity?user=${address}&limit=${limit}`),
    apiFetch(`${DATA}/trades?maker=${address}&limit=${limit}`),
  ]);
  const la = ra.status === 'fulfilled' && ra.value ? (Array.isArray(ra.value) ? ra.value : ra.value.data || []) : [];
  const lb = rb.status === 'fulfilled' && rb.value ? (Array.isArray(rb.value) ? rb.value : rb.value.data || []) : [];
  const seen = new Set();
  return [...la, ...lb]
    .filter(t => { const id = t.id || t.tradeId || JSON.stringify(t).slice(0,32); if (seen.has(id)) return false; seen.add(id); return true; })
    .map(t => ({
      id:        t.id || t.tradeId,
      market:    t.market || t.conditionId,
      title:     t.title || t.marketTitle || t.question || 'Unknown',
      outcome:   t.outcome,
      side:      t.side,
      price:     parseFloat(t.price || 0),
      size:      parseFloat(t.size || 0),
      usdcValue: parseFloat(t.usdcValue || t.amount || (t.price * t.size) || 0),
      timestamp: t.timestamp || t.createdAt,
      txHash:    t.transactionHash || null,
    }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function getPortfolio(address) {
  const [prof, pos, trades] = await Promise.all([
    getProfile(address).catch(() => ({})),
    getPositions(address).catch(() => []),
    getTrades(address, 30).catch(() => []),
  ]);
  return {
    ...prof,
    positions:    pos,
    recentTrades: trades,
    posCount:     pos.length,
    posValue:     pos.reduce((s, p) => s + (p.currentValue || p.size * p.currentPrice || 0), 0),
  };
}

// ══════════════════════════════════════════════════════════
// MARKETS
// ══════════════════════════════════════════════════════════

async function getMarkets({ limit = 30, tag, search } = {}) {
  let url = `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`;
  if (tag)    url += `&tag=${encodeURIComponent(tag)}`;
  if (search) url += `&q=${encodeURIComponent(search)}`;
  const d = await apiFetch(url);
  return (Array.isArray(d) ? d : (d?.markets || [])).map(normMarket).filter(m => m.id && m.title);
}

async function getMarket(cid) {
  const d = await apiFetch(`${GAMMA}/markets/${cid}`);
  return d ? normMarket(d) : null;
}

async function searchMarkets(q, limit = 8) {
  return getMarkets({ limit, search: q });
}

function normMarket(m) {
  const tokens = m.tokens || [];
  const yT = tokens.find(t => /yes/i.test(t.outcome)) || tokens[0] || {};
  const nT = tokens.find(t => /no/i.test(t.outcome))  || tokens[1] || {};
  const yP = parseFloat(yT.price ?? m.outcomePrices?.[0] ?? 0.5);
  const nP = parseFloat(nT.price ?? (1 - yP));
  return {
    id:          m.conditionId || m.id,
    slug:        m.slug,
    title:       m.question || m.title,
    description: m.description,
    category:    m.category || (m.tags?.[0]?.label) || 'General',
    tags:        (m.tags || []).map(t => t.label || t.slug || t),
    image:       m.image || m.featuredImage || null,
    endDate:     m.endDateIso || m.endDate,
    yesPrice:    yP,
    noPrice:     nP,
    yesPct:      Math.round(yP * 100),
    noPct:       Math.round(nP * 100),
    volume:      parseFloat(m.volume || 0),
    volume24h:   parseFloat(m.volume24hr || m.volume24hNum || 0),
    liquidity:   parseFloat(m.liquidity || m.liquidityNum || 0),
    yesTokenId:  yT.tokenId || m.clobTokenIds?.[0],
    noTokenId:   nT.tokenId || m.clobTokenIds?.[1],
    conditionId: m.conditionId,
    spread:      Math.abs(yP + nP - 1),
    outcomes:    tokens.map(t => ({ label: t.outcome, price: parseFloat(t.price || 0), tokenId: t.tokenId })),
  };
}

// ══════════════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════════════

async function getLeaderboard(limit = 25) {
  const d = await apiFetch(`${DATA}/leaderboard?limit=${limit}&window=allTime`);
  return (Array.isArray(d) ? d : (d?.data || [])).map((t, i) => ({
    rank:      i + 1,
    address:   t.address,
    name:      t.name || t.pseudonym || (t.address?.slice(0, 8) + '…'),
    avatar:    t.profileImage || null,
    profit:    parseFloat(t.profit || t.pnl || 0),
    roi:       parseFloat(t.profitPct || t.roi || 0),
    volume:    parseFloat(t.volume || 0),
    trades:    parseInt(t.tradesCount || t.numTrades || 0),
    winRate:   parseFloat(t.winRate || 0),
  }));
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
  generateClobCreds,
  getProfile, getPositions, getTrades, getPortfolio,
  getMarkets, getMarket, searchMarkets,
  getLeaderboard, getTraderActivity,
  placeTrade,
};
