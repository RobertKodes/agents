export interface Fill {
  agent: string;
  owner: string;
  token: string;
  side: "buy" | "sell";
  ethWei: bigint; // ETH paid (buy) or received (sell)
  tokens: bigint;
  /** Owner of the counterparty flow, when attributable (e.g. agent-only phase). */
  counterpartyOwner?: string;
}

/**
 * Realized PnL per agent with average-cost accounting. Round trips against the same
 * owner's own fleet are excluded, so wash trading can't climb the board.
 */
export function realizedPnl(fills: Fill[]): Map<string, { realizedWei: bigint; volumeWei: bigint; excludedWei: bigint }> {
  const pos = new Map<string, { tokens: bigint; cost: bigint }>();
  const out = new Map<string, { realizedWei: bigint; volumeWei: bigint; excludedWei: bigint }>();
  for (const f of fills) {
    const row = out.get(f.agent) ?? { realizedWei: 0n, volumeWei: 0n, excludedWei: 0n };
    out.set(f.agent, row);
    if (f.counterpartyOwner && f.counterpartyOwner.toLowerCase() === f.owner.toLowerCase()) {
      row.excludedWei += f.ethWei;
      continue;
    }
    row.volumeWei += f.ethWei;
    const k = `${f.agent}|${f.token}`;
    const p = pos.get(k) ?? { tokens: 0n, cost: 0n };
    if (f.side === "buy") {
      p.tokens += f.tokens;
      p.cost += f.ethWei;
    } else if (p.tokens > 0n) {
      const sold = f.tokens > p.tokens ? p.tokens : f.tokens;
      const costOut = (p.cost * sold) / p.tokens;
      row.realizedWei += f.ethWei - costOut;
      p.tokens -= sold;
      p.cost -= costOut;
    }
    pos.set(k, p);
  }
  return out;
}
