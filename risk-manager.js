/**
 * server/risk-manager.js
 * 
 * Risk Management Engine:
 *   - Daily trade count enforcement
 *   - Per-trade budget limits (% of balance)
 *   - Max total exposure (% of balance in open positions)
 *   - Stop-loss monitoring per position
 *   - Kelly Criterion position sizing
 *   - PnL tracking (realized + unrealized)
 *   - Consecutive loss circuit breaker
 */

class RiskManager {
  constructor(config = {}) {
    this.config = {
      dailyLimit:       config.dailyLimit       || parseInt(process.env.BOT_DAILY_LIMIT)      || 4,
      maxBudgetPct:     config.maxBudgetPct     || parseInt(process.env.BOT_MAX_BUDGET_PCT)   || 20,   // % of balance per trade
      maxExposurePct:   config.maxExposurePct   || parseInt(process.env.BOT_MAX_EXPOSURE_PCT) || 60,   // % of balance in positions
      stopLossPct:      config.stopLossPct      || parseInt(process.env.BOT_STOP_LOSS_PCT)    || 50,   // % loss triggers exit
      minScore:         config.minScore         || parseInt(process.env.BOT_MIN_SCORE)        || 55,
      maxConsecLosses:  config.maxConsecLosses  || 3,   // Pause after N consecutive losses
    };

    // Session state
    this.sessionTrades    = [];       // All trades this session
    this.dailyTrades      = [];       // Trades today (reset at midnight)
    this.lastReset        = new Date().toDateString();
    this.consecLosses     = 0;
    this.paused           = false;    // Circuit breaker
    this.pauseReason      = null;
    this.realizedPnl      = 0;
    this.openPositions    = new Map();// conditionId → { entryPrice, size, outcome, entryTime }
  }

  // ── Daily reset ────────────────────────────────────────
  checkDayReset() {
    const today = new Date().toDateString();
    if (this.lastReset !== today) {
      this.dailyTrades = [];
      this.lastReset   = today;
      this.paused      = false;      // Reset circuit breaker each day
      this.pauseReason = null;
      return true;
    }
    return false;
  }

  // ══════════════════════════════════════════════════════
  // PRE-TRADE CHECKS — call before placing any trade
  // ══════════════════════════════════════════════════════

  /**
   * canTrade(balance, positionsValue, score)
   * Returns { allowed: bool, reason: string }
   */
  canTrade(balance, positionsValue = 0, score = 0) {
    this.checkDayReset();

    // Circuit breaker
    if (this.paused) {
      return { allowed: false, reason: `⛔ Paused: ${this.pauseReason}` };
    }

    // Daily limit
    if (this.dailyTrades.length >= this.config.dailyLimit) {
      return { allowed: false, reason: `Daily limit reached (${this.config.dailyLimit} trades)` };
    }

    // Balance
    if (balance < 0.50) {
      return { allowed: false, reason: `Balance $${balance.toFixed(2)} too low (min $0.50)` };
    }

    // Exposure limit — don't open more positions if already heavily invested
    const exposurePct = balance > 0 ? (positionsValue / balance) * 100 : 0;
    if (exposurePct >= this.config.maxExposurePct) {
      return {
        allowed: false,
        reason: `Exposure ${exposurePct.toFixed(0)}% >= limit ${this.config.maxExposurePct}% — wait for positions to resolve`,
      };
    }

    // AI score threshold
    if (score > 0 && score < this.config.minScore) {
      return { allowed: false, reason: `AI score ${score}/100 below threshold ${this.config.minScore}` };
    }

    // Consecutive losses
    if (this.consecLosses >= this.config.maxConsecLosses) {
      this.paused      = true;
      this.pauseReason = `${this.consecLosses} consecutive losses — paused for today`;
      return { allowed: false, reason: this.pauseReason };
    }

    return { allowed: true, reason: null };
  }

  /**
   * validateAmount(amount, balance)
   * Validates that the trade amount is safe
   */
  validateAmount(amount, balance) {
    const errors = [];
    const maxPerTrade = balance * (this.config.maxBudgetPct / 100);

    if (!amount || isNaN(amount))       errors.push('Amount is required');
    if (amount < 0.10)                  errors.push('Minimum amount is $0.10');
    if (amount > balance)               errors.push(`Amount $${amount} exceeds balance $${balance.toFixed(2)}`);
    if (amount > maxPerTrade)           errors.push(
      `Amount $${amount} exceeds max per-trade budget $${maxPerTrade.toFixed(2)} (${this.config.maxBudgetPct}% of balance)`
    );

    return { valid: errors.length === 0, errors };
  }

  // ══════════════════════════════════════════════════════
  // POSITION SIZING — Kelly Criterion
  // ══════════════════════════════════════════════════════

  /**
   * kellySize(balance, price, score)
   * Returns the optimal bet size using half-Kelly
   * 
   * Kelly: f* = (b*p - q) / b
   *   b = net odds (1/price - 1)
   *   p = win probability (= price + edge)
   *   q = 1 - p
   * 
   * Uses half-Kelly for safety. Always capped at maxBudgetPct of balance.
   */
  kellySize(balance, price, score = 60) {
    if (balance < 0.10 || price <= 0.01 || price >= 0.99) return 0;

    // Estimated edge above market price based on AI confidence
    const edge    = 0.02 + (score / 2000);               // 2%–7% above price
    const p       = Math.min(price + edge, 0.96);
    const q       = 1 - p;
    const b       = 1 / price - 1;                        // Net odds
    const fullK   = Math.max((b * p - q) / b, 0);
    const halfK   = fullK / 2;                            // Half-Kelly

    const maxBudget = balance * (this.config.maxBudgetPct / 100);
    const kellyAmt  = balance * halfK;
    const optimal   = Math.min(kellyAmt, maxBudget);

    return Math.max(0.10, Math.round(optimal * 100) / 100);
  }

  // ══════════════════════════════════════════════════════
  // STOP LOSS MONITORING
  // ══════════════════════════════════════════════════════

  /**
   * checkStopLoss(positions)
   * Returns array of positions that should be sold (hit stop loss)
   */
  checkStopLoss(positions) {
    const toSell = [];
    for (const pos of positions) {
      const entry = this.openPositions.get(pos.conditionId);
      if (!entry) continue;

      const currentPrice = pos.currentPrice || 0;
      const entryPrice   = entry.entryPrice  || pos.avgPrice || 0;
      if (entryPrice <= 0) continue;

      const lossPct = ((entryPrice - currentPrice) / entryPrice) * 100;
      if (lossPct >= this.config.stopLossPct) {
        toSell.push({
          ...pos,
          lossPct:    lossPct.toFixed(1),
          entryPrice,
          reason:     `Stop loss triggered: -${lossPct.toFixed(1)}% (limit: -${this.config.stopLossPct}%)`,
        });
      }
    }
    return toSell;
  }

  // ══════════════════════════════════════════════════════
  // TRADE RECORDING & PnL
  // ══════════════════════════════════════════════════════

  recordTrade(trade) {
    const record = {
      ...trade,
      recordedAt: new Date().toISOString(),
    };
    this.sessionTrades.push(record);
    this.dailyTrades.push(record);

    // Track open position
    if (trade.side === 'buy') {
      this.openPositions.set(trade.marketId, {
        entryPrice: trade.price,
        size:       trade.amount,
        outcome:    trade.outcome,
        entryTime:  Date.now(),
        orderId:    trade.orderId,
      });
    } else if (trade.side === 'sell') {
      const entry = this.openPositions.get(trade.marketId);
      if (entry) {
        const pnl = (trade.price - entry.entryPrice) * parseFloat(trade.amount);
        this.realizedPnl += pnl;

        // Track consecutive losses
        if (pnl < 0) {
          this.consecLosses++;
        } else {
          this.consecLosses = 0; // Reset on any win
        }

        this.openPositions.delete(trade.marketId);
      }
    }
  }

  // ── PnL summary ───────────────────────────────────────
  getPnLSummary() {
    const completed = this.sessionTrades.filter(t => t.pnl !== undefined);
    const wins      = completed.filter(t => (t.pnl || 0) > 0);
    const totalPnL  = completed.reduce((s, t) => s + (t.pnl || 0), 0);

    return {
      sessionTrades:    this.sessionTrades.length,
      todayTrades:      this.dailyTrades.length,
      dailyRemaining:   Math.max(0, this.config.dailyLimit - this.dailyTrades.length),
      realizedPnl:      Math.round(this.realizedPnl * 100) / 100,
      winRate:          completed.length > 0 ? Math.round((wins.length / completed.length) * 100) : 0,
      consecLosses:     this.consecLosses,
      paused:           this.paused,
      pauseReason:      this.pauseReason,
      openPositions:    this.openPositions.size,
    };
  }

  // ── Get / update config ───────────────────────────────
  getConfig()           { return { ...this.config }; }
  updateConfig(partial) { this.config = { ...this.config, ...partial }; }

  // ── Manual pause/resume ───────────────────────────────
  pause(reason = 'Manual pause')  { this.paused = true;  this.pauseReason = reason; }
  resume()                         { this.paused = false; this.pauseReason = null;  this.consecLosses = 0; }
}

module.exports = RiskManager;
