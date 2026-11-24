// Fresh-launch sniper strategy for the pump.fun replay (agent-fun/replay/v2).
// Own design: every coin is watched from its CreateEvent and may be bought only
// in its first few slots, and only when the opening tape looks organic: the
// creator did not load up or sell, at least two unrelated wallets bought in,
// net SOL is flowing in, and the price has not already run away. Stakes are
// small (a few hundredths of a SOL, capped at 1% of the real SOL reserve),
// winners are ridden with a trailing stop, losers are cut fast, and nothing is
// held past a short slot budget. Orders are split into pieces only when the
// bot's own fill count lags the pace the guardrails need.
//
// Deterministic by construction: no clock, no environment reads, no randomness;
// every map is walked in insertion order and every money value is a bigint.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps on every curve trade

// Tunables, all in plain units (SOL, slots, bps) unless noted.
const P = {
  minAge: 1, // youngest age (slots since create) at which a first buy may be decided
  maxAge: 4, // oldest age at which a first buy may still be decided
  stakeLamports: 30_000_000n, // 0.03 SOL aimed per coin
  minBuyLamports: 5_000_000n, // smallest single buy worth the tx fee
  minRqLamports: 1_000_000_000n, // real SOL reserve at entry, at least 1 SOL (so the 1% cap still buys >= 0.01 SOL)
  maxRqLamports: 40_000_000_000n,
  maxDevBuyLamports: 2_000_000_000n, // creator's own buys in the create slot, at most
  minBuyers: 3, // distinct non-creator buyers seen before entry
  maxRunupBps: 15_000, // price now over the create price, at most 1.5x
  flowWindow: 8, // slots of recent tape the entry flow is read over
  tpBps: 2_500, // take profit: exit once the position is worth this much over its cost
  slBps: 800, // stop loss: exit once it is worth this much under its cost
  trailArmBps: 800, // trailing stop arms once up this much
  trailBps: 1_500, // ...then exits on a fall of this much from the best value
  maxHold: 60, // exit after holding this many slots
  staleSlots: 60, // exit when no trade has hit the coin for this many slots
  buySlipBps: 10_000, // buys never refused for the price moving in the latency
  fillTarget: 300, // guardrail pacing: fills to reach over windowSeconds of block time
  windowSeconds: 21_600,
  baseSplit: 1,
  maxSplit: 4,
  minPieceLamports: 2_000_000n,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  biggestSellShareBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  spent: bigint;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();
let firstTime: number | null = null;
let nowTime = 0;
let filled = 0;

/** Pieces to split an order into now: more when the fill count lags its pace. */
function pieces(): number {
  if (firstTime === null) return P.baseSplit;
  const elapsed = Math.max(0, Math.min(P.windowSeconds, nowTime - firstTime));
  const due = (P.fillTarget * elapsed) / P.windowSeconds;
  if (filled >= due) return P.baseSplit;
  const behind = due - filled;
  return Math.min(P.maxSplit, P.baseSplit + (behind > P.fillTarget * 0.15 ? 2 : 1));
}

function splitBuy(mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] {
  let n = BigInt(Math.max(1, Math.min(k, room)));
  while (n > 1n && amount / n < P.minPieceLamports) n -= 1n;
  const piece = amount / n;
  const out: OrderInput[] = [];
  for (let i = 0n; i < n; i++) {
    const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
    out.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: P.buySlipBps });
  }
  return out;
}

function splitSell(mint: Pubkey, tokens: bigint, k: number, room: number): OrderInput[] {
  const n = BigInt(Math.max(1, Math.min(k, room)));
  const piece = tokens / n;
  if (piece === 0n) return [{ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 }];
  const out: OrderInput[] = [];
  for (let i = 0n; i < n; i++) {
    const amt = i === n - 1n ? tokens - piece * (n - 1n) : piece;
    out.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: 10_000 });
  }
  return out;
}

/** Net SOL bought minus sold, and distinct non-creator buyers, over the recent window. */
function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
  const from = slot - P.flowWindow;
  let drop = 0;
  while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
  if (drop > 0) c.recent.splice(0, drop);
  let net = 0n;
  const buyers = new Set<Pubkey>();
  for (const t of c.recent) {
    if (t.isBuy) {
      net += t.sol;
      if (t.user !== c.creator) buyers.add(t.user);
    } else {
      net -= t.sol;
    }
  }
  return { net, buyers: buyers.size };
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === side) return true;
  return false;
}

export const bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint, createSlot: e.slot, creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves), vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n, buyers: new Set(), bought: 0n, soldByOthers: 0n,
          biggestSellShareBps: 0n, devSold: false, lastTradeSlot: e.slot,
          recent: [], spent: 0n, done: false, complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.biggestSellShareBps) c.biggestSellShareBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      if (f.status === 'filled') filled += 1;
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n });
      }
    }
    for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
    }
    const k = pieces();

    // Exits first: take profit, stop loss, trailing stop, hold budget, staleness, creator sell.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, best: 0n };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (value > h.best) h.best = value;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
      }
      if (state.slot - h.openedSlot >= P.maxHold) exit = true;
      if (c !== undefined) {
        if (c.devSold) exit = true;
        if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
      }
      if (!exit) continue;
      orders.push(...splitSell(mint, pos.token_amount, k, cap - orders.length));
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // Entries: fresh launches whose opening tape looks organic.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete) continue;
      const age = state.slot - c.createSlot;
      if (age > P.maxAge) {
        c.done = true;
        continue;
      }
      if (age < P.minAge) continue;
      if (open >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold) {
        c.done = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      if (rq < P.minRqLamports || rq > P.maxRqLamports) continue;
      if (c.devBuy > P.maxDevBuyLamports) continue;
      if (c.buyers.size < P.minBuyers) continue;
      if (c.bought > 0n && c.soldByOthers * BPS > c.bought * 5_000n) continue; // others sold over half of what was bought
      if (c.biggestSellShareBps > 5_000n) continue; // one wallet dumped over half the reserve
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
      if (runup > BigInt(P.maxRunupBps)) continue;
      const fl = flow(c, state.slot);
      if (fl.net <= 0n || fl.buyers < 1) continue;
      const room = P.stakeLamports - c.spent;
      if (room < P.minBuyLamports) continue;
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = room < maxBuy ? room : maxBuy;
      if (amount < P.minBuyLamports) continue;
      if (free < amount + tx * 6n) continue;
      const buys = splitBuy(c.mint, amount, k, cap - orders.length);
      orders.push(...buys);
      free -= amount + tx * BigInt(buys.length);
      c.spent += amount;
      open += 1;
    }
    return orders;
  },
};
