/**
 * server/index.js — Main Express Server
 *
 * Start with: npm start  (or  node server/index.js)
 * Then open:  http://localhost:3001
 *
 * All endpoints:
 *   GET  /api/status          → server + bot + wallet status
 *   GET  /api/portfolio       → balance, positions, trades, PnL
 *   GET  /api/markets         → active markets (with optional ?tag= ?search=)
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
 *   GET  /api/bullpen/status  → is Bullpen CLI installed?
 *   POST /api/bullpen/run     → run any bullpen command (safe subset)
 *   GET  /api/bullpen/search  → bullpen polymarket search
 *   GET  /api/bullpen/price   → bullpen polymarket price
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const { ethers } = require('ethers');

const pmAPI        = require('./polymarket-api');
const bullpen      = require('./bullpen');
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
  const [bullpenOk, bullpenVer, skillOk] = await Promise.all([
    bullpen.isInstalled(),
    bullpen.version(),
    bullpen.isSkillInstalled(),
  ]);
  res.json({
    server:           'running',
    networkOk:        pmAPI.getNetworkStatus(),   // ← NEW: is Polymarket reachable?
    walletConnected:  !!wallet,
    walletAddress:    wallet?.address || null,
    bullpenInstalled: bullpenOk,
    bullpenVersion:   bullpenVer,
    bullpenSkill:     skillOk,
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
        walletConfigured:  false,
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
    const { tag, search, limit = 40 } = req.query;
    const markets = await pmAPI.getMarkets({ tag, search, limit: parseInt(limit) });
    res.json(markets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/market/:id', async (req, res) => {
  try {
    const market = await pmAPI.getMarket(req.params.id);
    if (!market) return res.status(404).json({ error: 'Market not found' });
    // Add Bullpen price if installed
    if (market.slug) {
      const bp = await bullpen.getMarketPrice(market.slug).catch(() => null);
      if (bp?.ok) market.bullpenPrice = bp.raw;
    }
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
      pmAPI.getMarkets({ limit: 60 }),
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
    const markets   = await pmAPI.getMarkets({ limit: 40 }).catch(() => []);

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
    const { marketId, slug, outcome, side, amount, title, useBullpen } = req.body;

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

    // Execute via bot engine (handles both Bullpen and CLOB)
    const bot    = getBot();
    bot.useBullpen = !!useBullpen;
    const result = await bot.manualTrade({
      marketId, slug, outcome: outcome.toUpperCase(),
      side: side.toLowerCase(), amount: parseFloat(amount),
      title: title || marketId,
    });

    // Also show Bullpen equivalent command
    result.bullpenCmd = side.toLowerCase() === 'buy'
      ? bullpen.buildBuyCmd(slug || marketId, outcome, amount)
      : bullpen.buildSellCmd(slug || marketId, outcome, amount);

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
    stopLoss, minScore, useBullpen,
  } = req.body;

  const bot    = getBot();
  const result = bot.start({ dailyLimit, maxBudgetPct, maxExposure, stopLoss, minScore, useBullpen });
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
// BULLPEN CLI ENDPOINTS
// ═══════════════════════════════════════════════════════════

app.get('/api/bullpen/status', async (req, res) => {
  const [installed, ver, skillInstalled] = await Promise.all([
    bullpen.isInstalled(),
    bullpen.version(),
    bullpen.isSkillInstalled(),
  ]);
  res.json({ installed, version: ver, skillInstalled,
    installCmd:    'brew install bullpenfi/tap/bullpen   OR   curl -fsSL https://cli.bullpen.fi/install.sh | sh',
    loginCmd:      'bullpen login',
    skillCmd:      'bullpen skill install',
    upgradeCmd:    'bullpen upgrade',
  });
});

// Install AI skill (bullpen skill install) — called from Settings UI
app.post('/api/bullpen/install-skill', async (req, res) => {
  const r = await bullpen.installSkill();
  res.json(r);
});

app.get('/api/bullpen/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  const r = await bullpen.searchMarkets(q);
  res.json(r);
});

app.get('/api/bullpen/price', async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const r = await bullpen.getMarketPrice(slug);
  res.json(r);
});

app.get('/api/bullpen/positions', requireWallet, async (req, res) => {
  const r = await bullpen.getPositions();
  res.json(r);
});

app.get('/api/bullpen/balances', requireWallet, async (req, res) => {
  const r = await bullpen.getBalances();
  res.json(r);
});

app.get('/api/bullpen/orders', requireWallet, async (req, res) => {
  const r = await bullpen.getOrders();
  res.json(r);
});

app.post('/api/bullpen/cancel-orders', requireWallet, async (req, res) => {
  const r = await bullpen.cancelAllOrders();
  res.json(r);
});

app.get('/api/bullpen/leaderboard', async (req, res) => {
  const r = await bullpen.getLeaderboard();
  res.json(r);
});

app.get('/api/bullpen/feed', async (req, res) => {
  const r = await bullpen.getTradeFeed();
  res.json(r);
});

app.post('/api/bullpen/discover', async (req, res) => {
  const r = await bullpen.discoverMarkets();
  res.json(r);
});

// ── Bullpen buy/sell (explicitly via CLI) ──────────────────
app.post('/api/bullpen/buy', requireWallet, async (req, res) => {
  const { slug, outcome, amount } = req.body;
  if (!slug || !outcome || !amount) return res.status(400).json({ error: 'slug, outcome, amount required' });

  const portfolio  = await pmAPI.getPortfolio(wallet.address).catch(() => ({ cashBalance: 0 }));
  const validation = riskManager.validateAmount(parseFloat(amount), portfolio.cashBalance || 0);
  if (!validation.valid) return res.status(400).json({ error: validation.errors.join('; ') });

  const r = await bullpen.buyShares(slug, outcome, amount, true);
  if (r.ok) {
    riskManager.recordTrade({
      marketId: slug, outcome, side: 'buy',
      amount: parseFloat(amount), price: 0.5, // Price unknown from CLI
      orderId: `BP_${Date.now()}`, simulated: false, source: 'bullpen',
    });
  }
  res.json({ ...r, cmd: bullpen.buildBuyCmd(slug, outcome, amount) });
});

app.post('/api/bullpen/sell', requireWallet, async (req, res) => {
  const { slug, outcome, shares } = req.body;
  if (!slug || !outcome || !shares) return res.status(400).json({ error: 'slug, outcome, shares required' });
  const r = await bullpen.sellShares(slug, outcome, shares, true);
  res.json({ ...r, cmd: bullpen.buildSellCmd(slug, outcome, shares) });
});

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

  const bullpenOk = await bullpen.isInstalled();
  console.log(`${bullpenOk ? '✅' : '⚠️ '} Bullpen CLI: ${bullpenOk ? await bullpen.version() : 'not installed (optional)'}`);
  console.log(`${claudeApiKey ? '✅' : '⚠️ '} Claude AI:   ${claudeApiKey ? 'configured' : 'no key (add to .env or Settings)'}`);

  app.listen(PORT, () => {
    console.log(`\n🚀 Server running → http://localhost:${PORT}`);
    console.log(`📊 Open http://localhost:${PORT} in your browser\n`);
  });
})();
