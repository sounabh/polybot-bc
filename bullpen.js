
/**
 * server/bullpen.js
 *
 * Wraps Bullpen CLI via Node.js child_process.
 *
 * Bullpen CLI does TWO things for us:
 *  1. DIRECT trading commands: buy, sell, positions, price, search, etc.
 *  2. AI SKILL integration: `bullpen skill install` teaches Claude Code
 *     to call Bullpen commands through natural language. Our server's
 *     AI (ai-scorer.js) can use this same skill as a tool when analyzing.
 *
 * Full command reference: https://cli.bullpen.fi
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── Check installation ────────────────────────────────────
async function isInstalled() {
  try { 
    await execAsync('bullpen --version', { timeout: 5000 }); 
    return true; 
  } catch { 
    return false; 
  }
}

async function version() {
  try { 
    const { stdout } = await execAsync('bullpen --version', { timeout: 5000 }); 
    return stdout.trim(); 
  } catch { 
    return null; 
  }
}

// Check if AI skill is installed (bullpen skill install was run)
async function isSkillInstalled() {
  try {
    const { stdout } = await execAsync('bullpen skill list 2>&1', { timeout: 5000 });
    return stdout.toLowerCase().includes('polymarket') || stdout.toLowerCase().includes('bullpen');
  } catch { 
    return false; 
  }
}

// Install the AI skill (teaches Claude Code / our AI about Bullpen commands)
async function installSkill() {
  try {
    const { stdout } = await execAsync('bullpen skill install --yes 2>&1', { timeout: 30000 });
    return { ok: true, output: stdout.trim() };
  } catch (e) {
    return { ok: false, output: e.message };
  }
}

// ── Generic command runner ────────────────────────────────
async function run(args, opts = {}) {
  const cmd     = `bullpen ${args}`;
  const timeout = opts.timeout || 30000;
  try {
    console.log(`[Bullpen] ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 });
    if (stderr && !opts.ignoreStderr) console.warn(`[Bullpen] stderr: ${stderr.slice(0, 200)}`);
    return { ok: true, output: stdout.trim(), raw: stdout };
  } catch (e) {
    return { ok: false, output: '', error: e.message };
  }
}

function tryJSON(s) { 
  try { 
    return JSON.parse(s); 
  } catch { 
    return null; 
  } 
}

// ═══════════════════════════════════════════════════════════
// PORTFOLIO & ACCOUNT
// ═══════════════════════════════════════════════════════════
async function getBalances()  { 
  const r = await run('portfolio balances');     
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getPositions() { 
  const r = await run('polymarket positions');   
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getActivity()  { 
  const r = await run('polymarket activity');    
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getOrders() { 
  const r = await run('polymarket orders');      
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function cancelAllOrders() { 
  const r = await run('polymarket orders cancel --all --yes', { timeout: 30000 }); 
  return { ok: r.ok, raw: r.output }; 
}

// ═══════════════════════════════════════════════════════════
// MARKET DISCOVERY
// ═══════════════════════════════════════════════════════════
async function discoverMarkets() { 
  const r = await run('polymarket discover', { timeout: 20000 });                    
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function searchMarkets(query) { 
  const s = query.replace(/[`$"\\]/g,''); 
  const r = await run(`polymarket search "${s}"`, { timeout: 20000 }); 
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getMarketPrice(slug) { 
  const r = await run(`polymarket price ${slug}`, { timeout: 10000 });              
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getMarketHolders(slug) { 
  const r = await run(`polymarket holders ${slug}`, { timeout: 10000 });          
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getTradeFeed() { 
  const r = await run('polymarket feed --type trades', { timeout: 15000 });         
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

async function getLeaderboard() { 
  const r = await run('polymarket data leaderboard', { timeout: 20000 });           
  return { ok: r.ok, raw: r.output, parsed: tryJSON(r.output) }; 
}

// ═══════════════════════════════════════════════════════════
// TRADING
// ═══════════════════════════════════════════════════════════

/**
 * buyShares — natural language equivalent:
 *   "Buy $1 of Yes on will-bitcoin-hit-100k"
 *   → bullpen polymarket buy will-bitcoin-hit-100k "Yes" 1.00 --yes
 */
async function buyShares(slug, outcome, amount, confirm = true) {
  const amt    = parseFloat(amount).toFixed(2);
  const out    = outcome.charAt(0).toUpperCase() + outcome.slice(1).toLowerCase();
  const flag   = confirm ? '--yes' : '';
  const r      = await run(`polymarket buy ${slug} "${out}" ${amt} ${flag}`, { timeout: 30000 });
  return { 
    ok: r.ok, 
    raw: r.output, 
    parsed: tryJSON(r.output),
    cmd: buildBuyCmd(slug, outcome, amount) 
  };
}

/**
 * sellShares — natural language equivalent:
 *   "Sell my Yes shares on will-bitcoin-hit-100k at 65 cents"
 *   → bullpen polymarket sell will-bitcoin-hit-100k "Yes" <shares> --yes
 */
async function sellShares(slug, outcome, shares, confirm = true) {
  const sh  = parseFloat(shares).toFixed(2);
  const out = outcome.charAt(0).toUpperCase() + outcome.slice(1).toLowerCase();
  const flag= confirm ? '--yes' : '';
  const r   = await run(`polymarket sell ${slug} "${out}" ${sh} ${flag}`, { timeout: 30000 });
  return { 
    ok: r.ok, 
    raw: r.output, 
    parsed: tryJSON(r.output),
    cmd: buildSellCmd(slug, outcome, shares) 
  };
}

/**
 * limitBuy / limitSell — set limit orders
 *   "Set a limit order to buy Yes at 45 cents"
 *   → bullpen polymarket limit-buy <slug> "Yes" --price 0.45 --shares 10 --yes
 */
async function limitBuy(slug, outcome, price, shares, confirm = true) {
  const out  = outcome.charAt(0).toUpperCase() + outcome.slice(1).toLowerCase();
  const flag = confirm ? '--yes' : '';
  const r    = await run(`polymarket limit-buy ${slug} "${out}" --price ${price} --shares ${shares} ${flag}`, { timeout: 30000 });
  return { ok: r.ok, raw: r.output };
}

async function limitSell(slug, outcome, price, shares, confirm = true) {
  const out  = outcome.charAt(0).toUpperCase() + outcome.slice(1).toLowerCase();
  const flag = confirm ? '--yes' : '';
  const r    = await run(`polymarket limit-sell ${slug} "${out}" --price ${price} --shares ${shares} ${flag}`, { timeout: 30000 });
  return { ok: r.ok, raw: r.output };
}

// ═══════════════════════════════════════════════════════════
// AI-DRIVEN BULLPEN EXECUTION
// Called by ai-scorer.js when AI decides to use Bullpen
// This mirrors what `bullpen skill install` enables for Claude Code
// ═══════════════════════════════════════════════════════════

/**
 * executeNaturalLanguage
 *
 * Translates an AI trade decision into the correct Bullpen command
 * and executes it. This is what `bullpen skill install` does for Claude Code —
 * we replicate it server-side so our bot can do the same.
 *
 * Examples of what this handles:
 *   { action:'buy',  slug:'will-mi-win-ipl', outcome:'Yes', amount:1.00 }
 *   { action:'sell', slug:'will-mi-win-ipl', outcome:'Yes', shares:5.00 }
 *   { action:'price', slug:'will-mi-win-ipl' }
 *   { action:'search', query:'IPL cricket 2025' }
 *   { action:'positions' }
 *   { action:'balances' }
 */
async function executeNaturalLanguage(decision) {
  switch (decision.action) {
    case 'buy':
      return buyShares(decision.slug, decision.outcome, decision.amount, true);
    case 'sell':
      return sellShares(decision.slug, decision.outcome, decision.shares || decision.amount, true);
    case 'limit-buy':
      return limitBuy(decision.slug, decision.outcome, decision.price, decision.shares, true);
    case 'limit-sell':
      return limitSell(decision.slug, decision.outcome, decision.price, decision.shares, true);
    case 'price':
      return getMarketPrice(decision.slug);
    case 'search':
      return searchMarkets(decision.query);
    case 'positions':
      return getPositions();
    case 'balances':
      return getBalances();
    case 'orders':
      return getOrders();
    case 'cancel':
      return cancelAllOrders();
    default:
      return { ok: false, error: `Unknown action: ${decision.action}` };
  }
}

// ── CLI command string builders (shown in UI) ─────────────
const buildBuyCmd    = (slug, outcome, amount) => `bullpen polymarket buy ${slug} "${outcome}" ${parseFloat(amount).toFixed(2)} --yes`;
const buildSellCmd   = (slug, outcome, shares) => `bullpen polymarket sell ${slug} "${outcome}" ${parseFloat(shares).toFixed(2)} --yes`;
const buildPriceCmd  = (slug)                  => `bullpen polymarket price ${slug}`;
const buildSearchCmd = (query)                 => `bullpen polymarket search "${query}"`;

module.exports = {
  isInstalled, 
  version, 
  isSkillInstalled, 
  installSkill,
  run,
  getBalances, 
  getPositions, 
  getActivity, 
  getOrders, 
  cancelAllOrders,
  discoverMarkets, 
  searchMarkets, 
  getMarketPrice, 
  getMarketHolders,
  getTradeFeed, 
  getLeaderboard,
  buyShares, 
  sellShares, 
  limitBuy, 
  limitSell,
  executeNaturalLanguage,
  buildBuyCmd, 
  buildSellCmd, 
  buildPriceCmd, 
  buildSearchCmd,
};
