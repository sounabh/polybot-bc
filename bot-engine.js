/**
 * server/bot-engine.js
 * 
 * Auto-Trading Loop:
 *   - Runs every BOT_CHECK_INTERVAL_MIN minutes on the server
 *   - Uses RiskManager for all pre-trade checks
 *   - Uses AIScorer to pick the best market
 *   - Places trades via CLOB v2 (server-side signing with private key)
 *   - Monitors stop-losses on existing positions
 *   - Maintains complete activity log
 * 
 * Multiple bets per day are supported up to BOT_DAILY_LIMIT.
 * Each cycle can place AT MOST 1 trade (to avoid over-trading).
 * Multiple trades accumulate across cycles throughout the day.
 */

const pmAPI        = require('./polymarket-api');
const aiScorer     = require('./ai-scorer');

const INTERVAL_MIN = parseInt(process.env.BOT_CHECK_INTERVAL_MIN) || 15;

class BotEngine {
  constructor({ wallet, creds, riskManager }) {
    this.wallet      = wallet;
    this.creds       = creds;
    this.riskManager = riskManager;
    this.running     = false;
    this.timer       = null;
    this.logs        = [];
    this.lastCycle   = null;
    this.cycleCount  = 0;

    // Active market targets (user can queue specific markets to watch)
    this.targetMarkets = new Set();  // conditionIds the bot should prioritise
  }

  // ── Logging ──────────────────────────────────────────
  log(msg, level = 'info') {
    const entry = { time: new Date().toISOString(), msg, level };
    this.logs.unshift(entry);
    if (this.logs.length > 500) this.logs.length = 500;
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '▸';
    console.log(`[Bot] ${prefix} ${msg}`);
    return entry;
  }

  // ── Start / Stop ──────────────────────────────────────
  start(opts = {}) {
    if (this.running) return { ok: false, msg: 'Already running' };

    if (opts.dailyLimit)    this.riskManager.updateConfig({ dailyLimit:     opts.dailyLimit });
    if (opts.maxBudgetPct)  this.riskManager.updateConfig({ maxBudgetPct:   opts.maxBudgetPct });
    if (opts.maxExposure)   this.riskManager.updateConfig({ maxExposurePct: opts.maxExposure });
    if (opts.stopLoss)      this.riskManager.updateConfig({ stopLossPct:    opts.stopLoss });
    if (opts.minScore)      this.riskManager.updateConfig({ minScore:       opts.minScore });
    this.running = true;
    this.log(`Bot started | ${this.riskManager.config.dailyLimit} trades/day | ${this.riskManager.config.maxBudgetPct}% budget | Stop-loss ${this.riskManager.config.stopLossPct}%`);

    // First cycle soon, then on interval
    setTimeout(() => this._cycle(), 10000);
    this.timer = setInterval(() => this._cycle(), INTERVAL_MIN * 60 * 1000);

    return { ok: true };
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log('Bot stopped');
    return { ok: true };
  }

  // ── Add / remove target markets ───────────────────────
  addTarget(conditionId)    { this.targetMarkets.add(conditionId);    this.log(`Target added: ${conditionId.slice(0,20)}…`); }
  removeTarget(conditionId) { this.targetMarkets.delete(conditionId); this.log(`Target removed: ${conditionId.slice(0,20)}…`); }
  clearTargets()             { this.targetMarkets.clear();             this.log('All targets cleared'); }

  // ══════════════════════════════════════════════════════
  // MAIN TRADING CYCLE
  // ══════════════════════════════════════════════════════

  async _cycle() {
    if (!this.running) return;
    this.cycleCount++;
    this.lastCycle = new Date().toISOString();
    this.riskManager.checkDayReset();

    const pnl = this.riskManager.getPnLSummary();
    this.log(`Cycle #${this.cycleCount} | Today: ${pnl.todayTrades}/${this.riskManager.config.dailyLimit} | P&L: $${pnl.realizedPnl.toFixed(2)}`);

    try {
      // ── STEP 1: Fetch fresh data ──────────────────────
      const [portfolio, leaderboard] = await Promise.all([
        pmAPI.getPortfolio(this.wallet.address),
        pmAPI.getLeaderboard(10),
      ]);

      const balance   = portfolio.cashBalance || 0;
      const positions = portfolio.positions   || [];
      const posValue  = positions.reduce((s, p) => {
        const cv = p.currentValue;
        if (cv != null && Number.isFinite(cv) && cv > 0) return s + cv;
        const sz = parseFloat(p.size) || 0;
        const px = parseFloat(p.currentPrice) || 0;
        return s + sz * px;
      }, 0);

      this.log(`Balance: $${balance.toFixed(2)} | Positions: ${positions.length} ($${posValue.toFixed(2)})`);

      // ── STEP 2: Check stop losses ─────────────────────
      const stopLossHits = this.riskManager.checkStopLoss(positions);
      for (const pos of stopLossHits) {
        this.log(`Stop-loss hit on "${pos.title}" — ${pos.reason}`, 'warn');
        await this._executeSell(pos.conditionId, pos.outcome, pos.size, `Stop-loss: ${pos.reason}`);
      }

      // ── STEP 3: Pre-trade checks ──────────────────────
      const check = this.riskManager.canTrade(balance, posValue, 0);
      if (!check.allowed) {
        this.log(`Trade blocked: ${check.reason}`);
        return;
      }

      // ── STEP 4: Fetch markets ─────────────────────────
      // Get target markets first (if user specified any), then fill with general markets
      let markets = [];

      if (this.targetMarkets.size > 0) {
        const targetFetches = await Promise.allSettled(
          [...this.targetMarkets].map(id => pmAPI.getMarket(id))
        );
        markets = targetFetches
          .filter(r => r.status === 'fulfilled' && r.value)
          .map(r => r.value);
        this.log(`Loaded ${markets.length} target market(s)`);
      }

      // Supplement with general markets
      const generalMarkets = await pmAPI.getMarkets({ limit: 120 });
      markets = [...markets, ...generalMarkets.filter(m => !this.targetMarkets.has(m.id))];

      this.log(`Analysing ${markets.length} markets…`);

      // ── STEP 5: AI selects best trade ─────────────────
      const decision = await aiScorer.selectBest({
        balance,
        markets,
        leaderboard,
        positions,
        riskManager: this.riskManager,
      });

      if (!decision.action) {
        this.log(`No trade: ${decision.reason}${decision.bestMarket ? ` (best: ${decision.bestMarket})` : ''}`);
        return;
      }

      // ── STEP 6: Validate amount ───────────────────────
      const validation = this.riskManager.validateAmount(decision.amount, balance);
      if (!validation.valid) {
        this.log(`Amount validation failed: ${validation.errors.join(', ')}`, 'warn');
        return;
      }

      this.log(`Best opportunity: "${decision.title}"`);
      this.log(`  → BUY ${decision.outcome} @ ${(decision.price * 100).toFixed(0)}¢ | Score ${decision.score}/100 ${decision.rating}`);
      this.log(`  → Amount: $${decision.amount.toFixed(2)} | ${decision.reasons.join(' · ')}`);

      // ── STEP 7: Execute trade ─────────────────────────
      const result = await this._executeBuy({
        marketId: decision.marketId,
        slug:     decision.slug,
        outcome:  decision.outcome,
        amount:   decision.amount,
        title:    decision.title,
      });

      // ── STEP 8: Record trade ──────────────────────────
      const tradeRecord = {
        ...result,
        title:   decision.title,
        aiScore: decision.score,
        aiRating: decision.rating,
        aiReasons: decision.reasons,
      };
      this.riskManager.recordTrade(tradeRecord);

      const updatedPnl = this.riskManager.getPnLSummary();
      this.log(`Today: ${updatedPnl.todayTrades}/${this.riskManager.config.dailyLimit} trades | Remaining today: ${updatedPnl.dailyRemaining}`);

    } catch (e) {
      this.log(`Cycle error: ${e.message}`, 'error');
      console.error('[Bot] Full error:', e);
    }
  }

  // ── Execute a BUY (CLOB v2) ───────────────────────────
  async _executeBuy({ marketId, slug, outcome, amount, title }) {
    this.log(`Executing BUY ${outcome} $${amount.toFixed(2)} on "${title}"…`);

    const result = await pmAPI.placeTrade({
      wallet: this.wallet, creds: this.creds,
      marketId, outcome, side: 'buy', amount,
    });

    this.log(result.simulated
      ? `Signed (pending funds) — Order: ${result.orderId}`
      : `LIVE trade placed — Order: ${result.orderId}`
    );

    return { ...result, source: 'clob_v2' };
  }

  // ── Execute a SELL (stop-loss or manual) ─────────────
  async _executeSell(marketId, outcome, size, reason) {
    this.log(`Executing SELL ${outcome} ${size} shares — ${reason}`);
    try {
      const result = await pmAPI.placeTrade({
        wallet: this.wallet, creds: this.creds,
        marketId, outcome, side: 'sell', amount: size,
      });
      const record = { ...result, side: 'sell', pnl: 0 };
      this.riskManager.recordTrade(record);
      this.log(`Stop-loss sell: ${result.simulated ? 'signed' : 'live'} — ${result.orderId}`);
    } catch (e) {
      this.log(`Stop-loss sell error: ${e.message}`, 'error');
    }
  }

  // ── Manual trade (called from API endpoint) ───────────
  async manualTrade({ marketId, slug, outcome, side, amount, title }) {
    this.log(`Manual trade: ${side.toUpperCase()} ${outcome} $${amount.toFixed(2)} on "${title}"`);

    const portfolio = await pmAPI.getPortfolio(this.wallet.address);
    const balance   = portfolio.cashBalance || 0;

    // Validate amount
    const validation = this.riskManager.validateAmount(amount, balance);
    if (!validation.valid) throw new Error(validation.errors.join('; '));

    let result;
    if (side === 'buy') {
      result = await this._executeBuy({ marketId, slug, outcome, amount, title });
    } else {
      await this._executeSell(marketId, outcome, amount, 'Manual sell');
      result = { success: true, side: 'sell', marketId, outcome, amount, orderId: `SELL_${Date.now()}` };
    }

    this.riskManager.recordTrade({ ...result, title, side, manual: true });
    return result;
  }

  // ── State getters ─────────────────────────────────────
  getStatus() {
    return {
      running:      this.running,
      cycleCount:   this.cycleCount,
      lastCycle:    this.lastCycle,
      logs:         this.logs,
      targetMarkets: [...this.targetMarkets],
      config:       this.riskManager.getConfig(),
      pnl:          this.riskManager.getPnLSummary(),
      trades:       this.riskManager.sessionTrades,
    };
  }
}

module.exports = BotEngine;
