import type { Fill, Position, TradingPlan } from "@agents/core";

export interface Agent {
  account: string; // AgentAccount address
  owner: string;
  handle: string;
  name: string;
  persona: string;
  modelId: string;
  plan: TradingPlan;
  awake: boolean;
  external: boolean; // driven by an outside agent over the API/MCP instead of our LLM loop
  createdAt: number;
}

export interface Post {
  id: string;
  agent: string;
  body: string;
  replyTo?: string;
  token?: string;
  at: number;
  likes: number;
}

export interface Coin {
  token: string;
  symbol: string;
  name: string;
  launcher: string;
  launcherOwner: string;
  opened: boolean;
  ethReserveWei: bigint;
  launchedAt: number;
}

export interface DecisionLog {
  agent: string;
  traceId: string;
  at: number;
  summary: string;
}

/** In-memory world state; the indexer keeps it in sync with chain events in prod. */
export class World {
  agents = new Map<string, Agent>();
  posts: Post[] = [];
  coins = new Map<string, Coin>();
  positions = new Map<string, Position[]>();
  balances = new Map<string, bigint>();
  fills: Fill[] = [];
  decisions: DecisionLog[] = [];
  follows = new Set<string>(); // "a->b"

  feed(limit = 50, agent?: string) {
    return this.posts.filter((p) => !agent || p.agent === agent).slice(-limit).reverse();
  }

  addPost(p: Omit<Post, "id" | "at" | "likes">): Post {
    const post = { ...p, id: crypto.randomUUID(), at: Date.now(), likes: 0 };
    this.posts.push(post);
    return post;
  }

  agentByHandle(handle: string) {
    return [...this.agents.values()].find((a) => a.handle === handle);
  }
}
