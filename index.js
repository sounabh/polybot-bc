/**
 * server/index.js — Main Express Server
 *
 * Start with: npm start  (or  node server/index.js)
 * Then open:  http://localhost:3001
 *
 * All endpoints:
 *   GET  /api/status          → server + bot + wallet status
 *   GET  /api/portfolio       → balance, positions, trades, PnL
 *   GET  /api/markets         → active markets (?tag= ?search= ?limit= ?offset= event pagination)
 *   GET  /api/leaderboard     → top traders
 *   GET  /api/trader/:addr    → specific trader activity
 *   GET  /api/suggestions     → AI trade suggestions
 *   POST /api/ai/analyze      → AI chat analysis (Claude)
 *   POST /api/trade           → manual buy or sell
 *   POST /api/bot/start       → start auto-trading loop
 *   POST /api/bot/stop        → stop bot
 *   GET  /api/bot/status      → bot state, logs, trades
 *   POST /api/bot/target      → add a market for bot to watch
 *   DELETE /api/bot/target    → remove target market
 *   GET  /api/integration/health     → Gamma, Data API, CLOB, Polygon RPC status
 *   GET  /api/gamma/tags             → tag list (categories)
 *   GET  /api/data/positions|activity|value → Data API proxies (?user=0x…)
 *   GET  /api/clob/price|midpoint|spread|book → CLOB v2 public reads (?token_id=)
 *   GET  /api/chain/collateral-balance → on-chain pUSD balance (?user=0x…)
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const { ethers } = require('ethers');

const pmAPI        = require('./polymarket-api');
const aiScorer     = require('./ai-scorer');
const RiskManager  = require('./risk-manager');
const BotEngine    = require('./bot-engine');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Initialise wallet from .env ───────────────────────────
let wallet = null;
let creds  = null;

async function initWallet() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk === '0xYOUR_PRIVATE_KEY_HERE') {
    console.warn('\n⚠️  No PRIVATE_KEY in .env — trading disabled. Bot will run in analysis-only mode.\n');
    return false;
  }
  try {
    wallet = new ethers.Wallet(pk);
    console.log(`✅ Wallet loaded: ${wallet.address}`);
    creds  = await pmAPI.generateClobCreds(wallet);
    console.log(`✅ CLOB v2 credentials generated (derived: ${!!creds.derived})`);
    return true;
  } catch (e) {
    console.error('❌ Wallet init failed:', e.message);
    return false;
  }
}

// ── Initialise risk manager + bot engine ──────────────────
const riskManager = new RiskManager();
let   botEngine   = null;

function getBot() {
  if (!botEngine) {
    botEngine = new BotEngine({ wallet, creds, riskManager });
  }
  return botEngine;
}

// ── Claude API key (from .env or set via /api/settings) ──
let claudeApiKey = process.env.CLAUDE_API_KEY || '';

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE — check wallet for trading endpoints
// ═══════════════════════════════════════════════════════════
function requireWallet(req, res, next) {
  if (!wallet) {
    return res.status(403).json({
      error: 'No wallet configured. Add PRIVATE_KEY to .env and restart.',
    });
  }
  next();
}

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════

app.get('/api/status', async (req, res) => {
  res.json({
    server:           'running',
    networkOk:        pmAPI.getNetworkStatus(),
    polygonRpcOk:     pmAPI.getPolygonRpcStatus(),
    walletConnected:  !!wallet,
    walletAddress:    wallet?.address || null,
    claudeConfigured: !!claudeApiKey,
    bot:              botEngine?.getStatus() || { running: false },
    riskConfig:       riskManager.getConfig(),
    pnl:              riskManager.getPnLSummary(),
    uptime:           process.uptime(),
  });
});

// ═══════════════════════════════════════════════════════════
// PORTFOLIO
// ═══════════════════════════════════════════════════════════

app.get('/api/portfolio', async (req, res) => {
  try {
    if (!wallet) {
      return res.json({
        address:           null,
        username:          null,
        avatar:            null,
        bio:               null,
        cashBalance:       0,
        realizedPnl:       0,
        unrealizedPnl:     0,
        totalVolume:       0,
        tradesCount:       0,
        positions:         [],
        recentTrades:      [],
        posCount:          0,
        posValue:          0,
        riskPnl:           riskManager.getPnLSummary(),
        walletConfigured: false,
        polymarketProfileAddress: null,
        cashBalanceSource: null,
        collateralToken: null,
      });
    }
    const portfolio = await pmAPI.getPortfolio(wallet.address);
    portfolio.riskPnl = riskManager.getPnLSummary();
    portfolio.walletConfigured = true;
    res.json(portfolio);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// MARKETS
// ═══════════════════════════════════════════════════════════

app.get('/api/markets', async (req, res) => {
  try {
    const { tag, search, limit = 80, offset } = req.query;
    const markets = await pmAPI.getMarkets({
      tag,
      search,
      limit: parseInt(limit, 10),
      offset: offset != null ? parseInt(offset, 10) : 0,
    });
    res.json(markets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/market/:id', async (req, res) => {
  try {
    const market = await pmAPI.getMarket(req.params.id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    res.json(market);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// LEADERBOARD & TRADERS
// ═══════════════════════════════════════════════════════════

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { limit = 25 } = req.query;
    const traders = await pmAPI.getLeaderboard(parseInt(limit));
    res.json(traders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trader/:address', async (req, res) => {
  try {
    const [profile, activity] = await Promise.all([
      pmAPI.getProfile(req.params.address),
      pmAPI.getTraderActivity(req.params.address, parseInt(req.query.limit) || 20),
    ]);
    res.json({ profile, activity });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// AI SUGGESTIONS
// ═══════════════════════════════════════════════════════════

app.get('/api/suggestions', requireWallet, async (req, res) => {
  try {
    const [portfolio, markets, leaderboard] = await Promise.all([
      pmAPI.getPortfolio(wallet.address),
      pmAPI.getMarkets({ limit: 100 }),
      pmAPI.getLeaderboard(10),
    ]);
    const suggestions = await aiScorer.generateSuggestions({
      balance:     portfolio.cashBalance || 0,
      markets,
      leaderboard,
      riskManager,
    });
    res.json(suggestions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Chat / Analyze ──────────────────────────────────────
app.post('/api/ai/analyze', requireWallet, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const portfolio = await pmAPI.getPortfolio(wallet.address).catch(() => ({ cashBalance: 0 }));
    const markets   = await pmAPI.getMarkets({ limit: 80 }).catch(() => []);

    const result = await aiScorer.analyzeWithClaude({
      userMessage: message,
      balance:     portfolio.cashBalance || 0,
      markets,
      apiKey:      claudeApiKey,
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// TRADING — Manual buy / sell
// ═══════════════════════════════════════════════════════════

app.post('/api/trade', requireWallet, async (req, res) => {
  try {
    const { marketId, slug, outcome, side, amount, title } = req.body;

    // Validate inputs
    if (!marketId || !outcome || !side || !amount) {
      return res.status(400).json({ error: 'marketId, outcome, side, amount all required' });
    }
    if (!['buy','sell'].includes(side.toLowerCase())) {
      return res.status(400).json({ error: 'side must be buy or sell' });
    }
    if (parseFloat(amount) < 0.10) {
      return res.status(400).json({ error: 'Minimum amount is $0.10' });
    }

    // Balance check
    const portfolio = await pmAPI.getPortfolio(wallet.address);
    const balance   = portfolio.cashBalance || 0;
    const validation = riskManager.validateAmount(parseFloat(amount), balance);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors.join('; ') });
    }

    const bot    = getBot();
    const result = await bot.manualTrade({
      marketId, slug, outcome: outcome.toUpperCase(),
      side: side.toLowerCase(), amount: parseFloat(amount),
      title: title || marketId,
    });

    res.json(result);
  } catch (e) {
    console.error('[Trade] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// BOT CONTROL
// ═══════════════════════════════════════════════════════════

app.post('/api/bot/start', requireWallet, (req, res) => {
  const {
    dailyLimit, maxBudgetPct, maxExposure,
    stopLoss, minScore,
  } = req.body;

  const bot    = getBot();
  const result = bot.start({ dailyLimit, maxBudgetPct, maxExposure, stopLoss, minScore });
  res.json({ ...result, status: bot.getStatus() });
});

app.post('/api/bot/stop', (req, res) => {
  const bot = getBot();
  bot.stop();
  res.json({ ok: true, status: bot.getStatus() });
});

app.get('/api/bot/status', (req, res) => {
  const bot = getBot();
  res.json(bot.getStatus());
});

// ── Target markets (bot watches these specifically) ────────
app.post('/api/bot/target', requireWallet, (req, res) => {
  const { conditionId } = req.body;
  if (!conditionId) return res.status(400).json({ error: 'conditionId required' });
  getBot().addTarget(conditionId);
  res.json({ ok: true, targets: [...getBot().targetMarkets] });
});

app.delete('/api/bot/target', (req, res) => {
  const { conditionId } = req.body;
  if (conditionId) getBot().removeTarget(conditionId);
  else             getBot().clearTargets();
  res.json({ ok: true, targets: [...getBot().targetMarkets] });
});

// ── Manual pause/resume ────────────────────────────────────
app.post('/api/bot/pause',  requireWallet, (req, res) => { riskManager.pause(req.body.reason);  res.json({ ok: true }); });
app.post('/api/bot/resume', requireWallet, (req, res) => { riskManager.resume();                res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════

app.get('/api/settings', (req, res) => {
  res.json({
    claudeConfigured: !!claudeApiKey,
    walletAddress:    wallet?.address || null,
    riskConfig:       riskManager.getConfig(),
  });
});

app.post('/api/settings/claude-key', (req, res) => {
  const { key } = req.body;
  claudeApiKey = key || '';
  res.json({ ok: true, configured: !!claudeApiKey });
});

app.post('/api/settings/risk', (req, res) => {
  riskManager.updateConfig(req.body);
  res.json({ ok: true, config: riskManager.getConfig() });
});

// ═══════════════════════════════════════════════════════════
// POLYMARKET INTEGRATION LAYER (Gamma + Data + CLOB + chain)
// ═══════════════════════════════════════════════════════════

app.get('/api/integration/health', async (req, res) => {
  try {
    res.json(await pmAPI.getIntegrationHealth());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gamma/tags', async (req, res) => {
  try {
    const tags = await pmAPI.getGammaTags(parseInt(req.query.limit, 10) || 500);
    res.json(tags);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/data/positions', async (req, res) => {
  try {
    const { user, limit = 100 } = req.query;
    if (!user || !/^0x[a-fA-F0-9]{40}$/i.test(String(user))) {
      return res.status(400).json({ error: 'user query param (0x wallet) required' });
    }
    const rows = await pmAPI.getPositions(user);
    const lim  = Math.min(parseInt(limit, 10) || 100, 500);
    res.json(rows.slice(0, lim));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/data/activity', async (req, res) => {
  try {
    const { user, limit = 100 } = req.query;
    if (!user || !/^0x[a-fA-F0-9]{40}$/i.test(String(user))) {
      return res.status(400).json({ error: 'user query param (0x wallet) required' });
    }
    const lim = Math.min(parseInt(limit, 10) || 100, 500);
    const rows = await pmAPI.getTrades(user, lim);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/data/value', async (req, res) => {
  try {
    const { user } = req.query;
    if (!user || !/^0x[a-fA-F0-9]{40}$/i.test(String(user))) {
      return res.status(400).json({ error: 'user query param (0x wallet) required' });
    }
    const v = await pmAPI.getUserValue(user);
    if (v == null) return res.status(502).json({ error: 'Data API unavailable' });
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clob/price', async (req, res) => {
  try {
    const { token_id, side } = req.query;
    if (!token_id) return res.status(400).json({ error: 'token_id required' });
    const r = await pmAPI.clobTokenPrice(String(token_id), side || 'buy');
    if (r == null) return res.status(502).json({ error: 'CLOB unavailable' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clob/midpoint', async (req, res) => {
  try {
    const { token_id } = req.query;
    if (!token_id) return res.status(400).json({ error: 'token_id required' });
    const r = await pmAPI.clobMidpoint(String(token_id));
    if (r == null) return res.status(502).json({ error: 'CLOB unavailable' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clob/spread', async (req, res) => {
  try {
    const { token_id } = req.query;
    if (!token_id) return res.status(400).json({ error: 'token_id required' });
    const r = await pmAPI.clobSpread(String(token_id));
    if (r == null) return res.status(502).json({ error: 'CLOB unavailable' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clob/book', async (req, res) => {
  try {
    const { token_id } = req.query;
    if (!token_id) return res.status(400).json({ error: 'token_id required' });
    const r = await pmAPI.clobOrderBook(String(token_id));
    if (r == null) return res.status(502).json({ error: 'CLOB unavailable' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chain/collateral-balance', async (req, res) => {
  try {
    const { user } = req.query;
    if (!user || !/^0x[a-fA-F0-9]{40}$/i.test(String(user))) {
      return res.status(400).json({ error: 'user query param (0x wallet) required' });
    }
    const bal = await pmAPI.getCollateralBalance(String(user));
    res.json({
      user:       String(user),
      balance:    bal,
      token:      'pUSD',
      contract:   pmAPI.collateralTokenAddress(),
      source:     bal != null ? 'chain' : 'unavailable',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Catch-all → serve frontend ─────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

(async () => {
  console.log('\n🎯 Polymarket AI Trading Bot\n');

  // Check network connectivity FIRST — most common failure point
  const networkOk = await pmAPI.checkNetwork();
  if (!networkOk) {
    console.error('\n⚠️  WARNING: Cannot reach Polymarket APIs.');
    console.error('   The server will start but portfolio/markets will not load.');
    console.error('   Diagnose with: nslookup gamma-api.polymarket.com');
    console.error('   Common fixes:');
    console.error('   - Check your internet connection');
    console.error('   - Try a VPN if Polymarket is geo-blocked in your region');
    console.error('   - Change DNS to 8.8.8.8: add nameserver 8.8.8.8 to /etc/resolv.conf\n');
  }

  await initWallet();

  await pmAPI.checkPolygonRpc();

  console.log(`${claudeApiKey ? '✅' : '⚠️ '} Claude AI:   ${claudeApiKey ? 'configured' : 'no key (add to .env or Settings)'}`);

  app.listen(PORT, () => {
    console.log(`\n🚀 Server running → http://localhost:${PORT}`);
    console.log(`📊 Open http://localhost:${PORT} in your browser\n`);
  });
})();
