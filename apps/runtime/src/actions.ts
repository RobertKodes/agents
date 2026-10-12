import { checkIntent, noveltyCheck, tickerAllowed, type AgentState, type CoinView, type TradeIntent } from "@agents/core";
import type { Tracer } from "@agents/trace";
import type { Chain, SimChain } from "./chain.js";
import type { Agent, World } from "./world.js";

export type Action =
  | { type: "post"; body: string; replyTo?: string; token?: string }
  | { type: "like"; postId: string }
  | { type: "follow"; handle: string }
  | { type: "launch"; name: string; symbol: string; pitch: string }
  | { type: "buy"; token: string; ethIn: string; reason: string }
  | { type: "sell"; token: string; tokensIn: string; reason: string };

/** Mirrors LaunchHook.LAUNCH_COOLDOWN so refused launches never cost gas. */
export const LAUNCH_COOLDOWN_MS = 60 * 60_000;

export interface ActionResult {
  action: Action;
  ok: boolean;
  detail: string;
  txHash?: string;
}

export interface Quoter {
  quoteBuy(token: string, ethIn: bigint): bigint;
  quoteSell(token: string, tokensIn: bigint): bigint;
}

export function agentState(world: World, a: Agent): AgentState {
  return { owner: a.owner, freeWei: world.balances.get(a.account) ?? 0n, positions: world.positions.get(a.account) ?? [], now: Date.now() };
}

export function coinView(world: World, q: Quoter, token: string): CoinView | null {
  const c = world.coins.get(token);
  if (!c) return null;
  return { token, launcherOwner: c.launcherOwner, opened: c.opened, totalSupply: 1_000_000_000n * 10n ** 18n, quoteBuy: (e) => q.quoteBuy(token, e), quoteSell: (t) => q.quoteSell(token, t) };
}

/** Applies one action under the platform rules. Used for our agents and external ones alike. */
export async function applyAction(world: World, chain: Chain, quoter: Quoter, agent: Agent, action: Action, tracer?: Tracer): Promise<ActionResult> {
  const run = async (): Promise<ActionResult> => {
    switch (action.type) {
      case "post": {
        const body = action.body.trim().slice(0, 500);
        if (!body) return { action, ok: false, detail: "empty" };
        const own = world.feed(20, agent.account).map((p) => p.body);
        const feed = world.feed(60).map((p) => p.body);
        const n = noveltyCheck(body, own, feed);
        if (!n.ok) return { action, ok: false, detail: n.reason };
        const p = world.addPost({ agent: agent.account, body, replyTo: action.replyTo, token: action.token });
        return { action, ok: true, detail: p.id };
      }
      case "like": {
        const p = world.posts.find((x) => x.id === action.postId);
        if (!p || p.agent === agent.account) return { action, ok: false, detail: "cannot like" };
        p.likes++;
        return { action, ok: true, detail: "liked" };
      }
      case "follow": {
        const t = world.agentByHandle(action.handle);
        if (!t || t.account === agent.account) return { action, ok: false, detail: "unknown agent" };
        world.follows.add(`${agent.account}->${t.account}`);
        return { action, ok: true, detail: "followed" };
      }
      case "launch": {
        const last = Math.max(0, ...[...world.coins.values()].filter((c) => c.launcher === agent.account).map((c) => c.launchedAt));
        if (Date.now() - last < LAUNCH_COOLDOWN_MS) return { action, ok: false, detail: "launch cooldown (1 per hour, enforced on-chain too)" };
        const symbol = action.symbol.toUpperCase();
        const t = tickerAllowed(symbol, [...world.coins.values()].map((c) => c.symbol));
        if (!t.ok) return { action, ok: false, detail: t.reason! };
        const { txHash, token } = await chain.launch(agent.account, action.name.slice(0, 32), symbol);
        world.coins.set(token, { token, symbol, name: action.name, launcher: agent.account, launcherOwner: agent.owner, opened: false, ethReserveWei: 0n, launchedAt: Date.now() });
        world.addPost({ agent: agent.account, body: action.pitch.slice(0, 500) || `Launched $${symbol}.`, token });
        return { action, ok: true, detail: token, txHash };
      }
      case "buy":
      case "sell": {
        const coin = coinView(world, quoter, action.token);
        if (!coin) return { action, ok: false, detail: "unknown coin" };
        const intent: TradeIntent = action.type === "buy"
          ? { kind: "buy", token: action.token, ethIn: BigInt(action.ethIn), reason: action.reason }
          : { kind: "sell", token: action.token, tokensIn: BigInt(action.tokensIn), reason: action.reason };
        const v = checkIntent(intent, agent.plan, agentState(world, agent), coin);
        if (!v.ok) return { action, ok: false, detail: `risk: ${v.reason}` };
        const { txHash, out } = await chain.execute(agent.account, v.order);
        settle(world, agent, v.order.kind, action.token, v.order.kind === "buy" ? v.order.ethIn : v.order.tokensIn, out);
        return { action, ok: true, detail: `${v.order.kind} filled, out=${out}${v.adjusted ? ` (${v.adjusted})` : ""}`, txHash };
      }
    }
  };
  if (!tracer) return run();
  return tracer.withSpan(`${action.type}`, action.type === "buy" || action.type === "sell" || action.type === "launch" ? "tx" : "tool_call", async (s) => {
    const r = await run();
    s.setAttrs({ ok: r.ok, txHash: r.txHash }).setOutput(r.detail);
    return r;
  }, { input: action });
}

function settle(world: World, agent: Agent, side: "buy" | "sell", token: string, amountIn: bigint, out: bigint) {
  const bal = world.balances.get(agent.account) ?? 0n;
  const positions = world.positions.get(agent.account) ?? [];
  let p = positions.find((x) => x.token === token);
  if (side === "buy") {
    world.balances.set(agent.account, bal - amountIn);
    if (!p) positions.push((p = { token, amount: 0n, costWei: 0n, openedAt: Date.now(), peakValueWei: 0n }));
    p.amount += out;
    p.costWei += amountIn;
  } else if (p) {
    world.balances.set(agent.account, bal + out);
    const costOut = p.amount > 0n ? (p.costWei * amountIn) / p.amount : 0n;
    p.amount -= amountIn;
    p.costWei -= costOut;
  }
  world.positions.set(agent.account, positions.filter((x) => x.amount > 0n));
  const coin = world.coins.get(token);
  if (coin) coin.ethReserveWei += side === "buy" ? amountIn : -out;
  world.fills.push({
    agent: agent.account, owner: agent.owner, token, side,
    ethWei: side === "buy" ? amountIn : out, tokens: side === "buy" ? out : amountIn,
    counterpartyOwner: coin && !coin.opened ? coin.launcherOwner : undefined,
  });
}

export type { SimChain };
