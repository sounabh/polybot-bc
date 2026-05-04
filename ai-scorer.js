/**
 * server/ai-scorer.js
 * 
 * AI Market Analysis:
 *   1. scoreMarket()   — scores 0-100 based on probability, volume, traders, liquidity
 *   2. selectBest()    — picks the best trade from a list of markets
 *   3. analyzeWithClaude() — asks Claude API to analyze a specific market or query
 */

const fetch = require('node-fetch');
const pmAPI = require('./polymarket-api');

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// ── Score a single market ─────────────────────────────────
function scoreMarket(market, topTraderActivity = [], leaderboard = []) {
  let score = 0;
  const reasons = [];
  const { yesPrice: yp, noPrice: np, volume24h: v24, liquidity: liq, endDate } = market;
  const dist = Math.abs(yp - 0.5);
  let outcome = null;

  // Probability edge (35 pts)
  if (dist >= 0.15 && dist <= 0.40) {
    score += Math.min(Math.round(dist * 70), 35);
    outcome = yp > 0.5 ? 'YES' : 'NO';
    reasons.push(`${outcome} at ${outcome === 'YES' ? market.yesPct : market.noPct}% — clear lean`);
  } else if (dist < 0.05) {
    score += 3; outcome = 'YES'; reasons.push('Near 50/50 — minimal edge');
  } else if (dist > 0.43) {
    score += 2; outcome = yp > np ? 'YES' : 'NO'; reasons.push('Near certainty — small return');
  } else {
    score += Math.round(dist * 40); outcome = yp > 0.5 ? 'YES' : 'NO'; reasons.push('Mild lean');
  }

  // Volume 24h (25 pts)
  if      (v24 >= 100000) { score += 25; reasons.push(`High vol $${fmtN(v24)}`); }
  else if (v24 >= 10000)  { score += 17; reasons.push(`Good vol $${fmtN(v24)}`); }
  else if (v24 >= 1000)   { score += 8;  reasons.push('Low volume'); }
  else                    { score -= 5;  reasons.push('Very low vol — risky'); }

  // Top trader signals (25 pts) — recent fills from leaderboard wallets on this market
  const bets = topTraderActivity.filter(t => t.market === market.id || t.market === market.conditionId);
  if (bets.length > 0) {
    const tally = {};
    bets.forEach(b => { tally[b.outcome] = (tally[b.outcome] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      outcome = top[0].toUpperCase();
      score  += Math.min(bets.length * 8, 25);
      reasons.push(`${bets.length} top-traders → ${outcome}`);
    }
  }

  // Leaderboard PnL context (6 pts) — simple risk-on / quality signal, not stock-picking
  const lb = Array.isArray(leaderboard) ? leaderboard.slice(0, 5) : [];
  if (lb.length >= 3) {
    const avgPnl = lb.reduce((s, t) => s + Math.max(0, parseFloat(t.profit) || 0), 0) / lb.length;
    if (avgPnl >= 500_000)      { score += 6; reasons.push('Top-5 leaderboard PnL very strong'); }
    else if (avgPnl >= 100_000) { score += 4; reasons.push('Top-5 leaderboard PnL solid'); }
    else if (avgPnl >= 20_000)  { score += 2; reasons.push('Leaderboard context positive'); }
  }

  // Liquidity (15 pts)
  if      (liq >= 50000)    { score += 15; reasons.push(`High liq $${fmtN(liq)}`); }
  else if (liq >= 10000)    { score += 9; }
  else if (market.spread > 0.06) { score -= 8; reasons.push('Wide spread'); }

  // Time penalties
  if (endDate) {
    const days = (new Date(endDate) - Date.now()) / 86400000;
    if (days < 0.5)     { score -= 30; reasons.push('Closes <12h'); }
    else if (days < 2)  { score -= 10; reasons.push(`Closes in ${(days*24).toFixed(0)}h`); }
    else if (days > 180){ score -= 5;  reasons.push('Very long duration'); }
  }

  score = Math.max(0, Math.min(100, score));
  const rp = outcome === 'YES' ? yp : np;

  return {
    marketId:   market.id || market.conditionId,
    slug:       market.slug,
    title:      market.title,
    score,
    rating:     score>=80?'🔥 Excellent':score>=65?'✅ Good':score>=50?'⚡ Fair':'⚠️ Weak',
    outcome:    outcome || 'YES',
    price:      rp,
    reasons,
    yesPct:     market.yesPct,
    noPct:      market.noPct,
    volume24h:  v24,
    liquidity:  liq,
    endDate:    market.endDate,
  };
}

// ── Select best trade from a list of markets ──────────────
async function selectBest({ balance, markets, leaderboard, positions = [], riskManager }) {
  // Check risk manager allows trading
  if (riskManager) {
    const posValue = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
    const check = riskManager.canTrade(balance, posValue, 0);
    if (!check.allowed) return { action: null, reason: check.reason };
  }

  // Fetch top trader activity for signal
  let traderActivity = [];
  try {
    const top3 = (leaderboard || []).slice(0, 3);
    const results = await Promise.allSettled(
      top3.map(t => pmAPI.getTraderActivity(t.address, 8))
    );
    traderActivity = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value || []);
  } catch (e) {
    console.warn('[AI] Trader activity fetch failed:', e.message);
  }

  // Exclude already-held markets
  const owned = new Set(positions.map(p => p.conditionId || p.market));

  // Score all eligible markets
  const ranked = markets
    .filter(m =>
      !owned.has(m.id) &&
      m.volume24h > 500 &&
      m.yesPrice > 0.05 &&
      m.yesPrice < 0.95
    )
    .map(m => scoreMarket(m, traderActivity, leaderboard))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { action: null, reason: 'No suitable markets after filtering' };

  const best = ranked[0];
  const minScore = riskManager?.config?.minScore || 55;

  if (best.score < minScore) {
    return {
      action:     null,
      reason:     `Best score ${best.score}/100 below threshold ${minScore} — no strong opportunity`,
      bestMarket: best.title,
      bestScore:  best.score,
    };
  }

  // Calculate position size
  const amount = riskManager
    ? riskManager.kellySize(balance, best.price, best.score)
    : Math.min(balance * 0.20, 10);

  if (amount < 0.10) return { action: null, reason: 'Calculated size < $0.10 — balance too low' };

  return {
    action:     'trade',
    marketId:   best.marketId,
    slug:       best.slug,
    title:      best.title,
    outcome:    best.outcome,
    side:       'buy',
    amount,
    price:      best.price,
    score:      best.score,
    rating:     best.rating,
    reasons:    best.reasons,
    confidence: Math.round((0.5 + best.score / 200) * 100),
  };
}

// ── Generate full AI suggestions for the suggestions page ──
async function generateSuggestions({ balance, markets, leaderboard, riskManager }) {
  let traderActivity = [];
  try {
    const top5 = (leaderboard || []).slice(0, 5);
    const results = await Promise.allSettled(
      top5.map(t => pmAPI.getTraderActivity(t.address, 10))
    );
    traderActivity = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value || []);
  } catch { /* proceed without */ }

  const scored = markets
    .filter(m => m.volume24h > 200 && m.id)
    .map(m => scoreMarket(m, traderActivity, leaderboard))
    .sort((a, b) => b.score - a.score);

  const withSize = scored.map(s => ({
    ...s,
    suggestedAmount: riskManager
      ? riskManager.kellySize(balance, s.price, s.score)
      : Math.min(1, balance * 0.1),
  }));

  const copySignals = traderActivity
    .filter(t => t.side === 'buy')
    .slice(0, 8)
    .map(t => {
      const m = markets.find(m => m.id === t.market || m.conditionId === t.market);
      return {
        ...t,
        marketTitle:     m?.title || t.title || 'Unknown',
        marketId:        m?.id    || t.market,
        slug:            m?.slug  || t.market,
        suggestedAmount: riskManager
          ? riskManager.kellySize(balance, t.price || 0.5, 50)
          : Math.min(1, balance * 0.1),
      };
    })
    .filter(t => t.marketId);

  return {
    balance,
    topPicks:     withSize.slice(0, 6).filter(s => s.score >= 35),
    categories: {
      highProbability: withSize.filter(s => s.price >= 0.65).slice(0, 4),
      balanced:        withSize.filter(s => s.price >= 0.35 && s.price < 0.65).slice(0, 4),
      longShots:       withSize.filter(s => s.price < 0.20).slice(0, 3),
    },
    copySignals,
    riskSummary:  riskManager?.getPnLSummary() || null,
    generatedAt:  new Date().toISOString(),
  };
}

// ── Ask Claude AI about a market or query ─────────────────
async function analyzeWithClaude({ userMessage, balance, markets, apiKey }) {
  if (!apiKey) {
    return { text: 'Claude API key not set. Add it in Settings to enable AI analysis.', action: null };
  }

  const balStr  = `$${parseFloat(balance || 0).toFixed(2)}`;
  const maxSafe = `$${Math.min(parseFloat(balance || 0) * 0.5, parseFloat(balance || 0)).toFixed(2)}`;

  const system = `You are a Polymarket prediction market trading assistant running on a Node.js server.

USER CONTEXT:
- USDC balance: ${balStr}
- Safe max bet: ${maxSafe} (50% of balance)
- You are analyzing markets to help the user decide whether to trade

YOUR JOB:
1. Use search_markets tool to find relevant markets when user asks
2. Analyze probability HONESTLY (market price = community consensus)
3. Propose trades via propose_trade — user must confirm, you NEVER auto-execute
4. Decline via decline_trade if: probability < 15%, closing very soon, or amount > 80% of balance

RULES:
- If user says "$1 bet on X": find that market, analyze, propose exactly $1 if probability >= 25%
- If probability < 30%: warn prominently  
- Never suggest more than ${maxSafe} unless explicitly asked
- Be direct and concise — max 3 sentences of analysis before proposing`;

  const tools = [
    {
      name: 'search_markets',
      description: 'Search Polymarket markets by topic or keyword',
      input_schema: {
        type: 'object',
        properties: {
          query:  { type: 'string', description: 'Search query' },
          tag:    { type: 'string', description: 'Category: sports, cricket, crypto, politics, etc.' },
          limit:  { type: 'number' },
        },
        required: ['query'],
      },
    },
    {
      name: 'propose_trade',
      description: 'Propose a specific trade for the user to confirm. Always call after analysis.',
      input_schema: {
        type: 'object',
        properties: {
          marketId:       { type: 'string' },
          slug:           { type: 'string' },
          title:          { type: 'string' },
          outcome:        { type: 'string', enum: ['YES', 'NO'] },
          side:           { type: 'string', enum: ['buy', 'sell'] },
          amount:         { type: 'number' },
          price:          { type: 'number' },
          winProbability: { type: 'number' },
          reasoning:      { type: 'string' },
          riskLevel:      { type: 'string', enum: ['low', 'medium', 'high', 'very_high'] },
          warning:        { type: 'string' },
        },
        required: ['marketId', 'title', 'outcome', 'amount', 'winProbability', 'reasoning', 'riskLevel'],
      },
    },
    {
      name: 'decline_trade',
      description: 'Decline to propose a trade and explain why.',
      input_schema: {
        type: 'object',
        properties: {
          reason:      { type: 'string' },
          alternative: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  ];

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 1500,
        system,
        messages:   [{ role: 'user', content: userMessage }],
        tools,
      }),
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    // Process tool calls
    let text = '', proposal = null;
    for (const blk of (data.content || [])) {
      if (blk.type === 'text') {
        text += blk.text;
      } else if (blk.type === 'tool_use') {
        const res = await _handleTool(blk.name, blk.input, markets);
        if (res.text)     text    += (text ? '\n\n' : '') + res.text;
        if (res.proposal) proposal = res.proposal;
      }
    }

    return { text: text || 'Analysis complete.', proposal, action: proposal ? 'CONFIRM_TRADE' : null };

  } catch (e) {
    console.error('[Claude] API error:', e.message);
    return { text: `AI error: ${e.message}`, action: null };
  }
}

async function _handleTool(name, inp, markets) {
  if (name === 'search_markets') {
    let mkts = await pmAPI.searchMarkets(inp.query, inp.limit || 6);
    if (!mkts.length && inp.tag) mkts = await pmAPI.getMarkets({ limit: 6, tag: inp.tag });
    if (!mkts.length) return { text: `No markets found for "${inp.query}".` };

    const lines = mkts.map((m, i) =>
      `**${i+1}. ${m.title}**\n   YES ${m.yesPct}% · NO ${m.noPct}% · Vol 24h: $${fmtN(m.volume24h)}`
    ).join('\n\n');
    return { text: `Found **${mkts.length} markets**:\n\n${lines}`, markets: mkts };
  }

  if (name === 'propose_trade') {
    const riskIcons = { low:'🟢', medium:'🟡', high:'🟠', very_high:'🔴' };
    const icon = riskIcons[inp.riskLevel] || '⚪';
    const pct  = inp.winProbability;
    const warn = inp.warning || (pct < 30 ? `⚠️ Only **${pct}%** probability — high risk of losing $${inp.amount}.` : '');

    const proposal = {
      marketId: inp.marketId,
      slug:     inp.slug,
      title:    inp.title,
      outcome:  inp.outcome,
      side:     inp.side || 'buy',
      amount:   inp.amount,
      price:    inp.price || 0.5,
    };

    const text = `${icon} **Trade Proposal**\n\n` +
      `📊 **${inp.title}**\n` +
      `🎯 ${(inp.side||'BUY').toUpperCase()} **${inp.outcome}** · Win prob: **${pct}%**\n` +
      `💰 Amount: **$${inp.amount} USDC**\n` +
      `💭 ${inp.reasoning}` +
      (warn ? `\n\n${warn}` : '');

    return { text, proposal };
  }

  if (name === 'decline_trade') {
    return {
      text: `🚫 **Not recommending this trade**\n\n${inp.reason}${inp.alternative ? '\n\n💡 ' + inp.alternative : ''}`,
    };
  }

  return { text: `Unknown tool: ${name}` };
}

function fmtN(n) {
  n = parseFloat(n || 0);
  return n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(0)}K` : n.toFixed(0);
}

module.exports = { scoreMarket, selectBest, generateSuggestions, analyzeWithClaude };
