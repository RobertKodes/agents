// End-to-end against a local anvil with the real contracts deployed.
//   RPC_URL=http://127.0.0.1:8547 POOL_MANAGER=0x.. REGISTRY=0x.. HOOK=0x.. tsx src/e2e-anvil.ts
import { PRESETS } from "@agents/core";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { applyAction } from "./actions.js";
import { ViemAgentChain } from "./chain.js";
import { Indexer, PoolQuoter } from "./onchain.js";
import { World, type Agent } from "./world.js";

const env = process.env;
const RPC = env.RPC_URL!;
const PM = env.POOL_MANAGER as Address;
const REGISTRY = env.REGISTRY as Address;
const HOOK = env.HOOK as Address;
// anvil default keys: 0 = runtime session key, 1 and 2 = two different owners
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const;
const session = privateKeyToAccount(KEYS[0]);
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const regAbi = parseAbi([
  "function create(string handle, string modelId, bytes32 profileHash, address sessionKey, uint256 maxTradeWei, uint256 dailyLimitWei) payable returns (address)",
  "event AgentCreated(address indexed account, address indexed owner, string handle, string modelId, bytes32 profileHash)",
]);

async function createAgent(ownerKey: `0x${string}`, handle: string): Promise<Agent> {
  const owner = privateKeyToAccount(ownerKey);
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: owner });
  const { request, result } = await pub.simulateContract({
    address: REGISTRY, abi: regAbi, functionName: "create",
    args: [handle, "demo/model", `0x${"0".repeat(64)}`, session.address, parseEther("1"), parseEther("5")],
    value: parseEther("3"), account: owner,
  });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
  return { account: result, owner: owner.address, handle, name: handle, persona: "", modelId: "demo/model", plan: { ...PRESETS.momentum, maxBuyWei: parseEther("0.5") }, awake: true, external: false, createdAt: Date.now() };
}

const world = new World();
const chain = new ViemAgentChain(RPC, foundry, KEYS[0], HOOK);
const quoter = new PoolQuoter(pub, PM, HOOK);
const indexer = new Indexer(pub, REGISTRY, HOOK, world);

const alpha = await createAgent(KEYS[1], "alpha");
const beta = await createAgent(KEYS[2], "beta");
for (const a of [alpha, beta]) { world.agents.set(a.account, a); world.balances.set(a.account, await pub.getBalance({ address: a.account as Address })); }
console.log("agents", alpha.account, beta.account);

const launch = await applyAction(world, chain, quoter, alpha, { type: "launch", name: "Relay", symbol: "RELAY", pitch: "Relay coin." });
console.log("launch", launch.ok, launch.detail, launch.txHash);
await indexer.pass(0n);
const token = launch.detail;
await quoter.refresh([token]);

const buy = await applyAction(world, chain, quoter, beta, { type: "buy", token, ethIn: parseEther("1").toString(), reason: "e2e" });
console.log("buy", buy.ok, buy.detail);
const own = await applyAction(world, chain, quoter, alpha, { type: "buy", token, ethIn: parseEther("0.01").toString(), reason: "own coin" });
console.log("own-fleet buy", own.ok, own.detail);

const bal = await pub.readContract({ address: token as Address, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [beta.account as Address] });
const r = await indexer.pass(0n);
console.log("indexed", r, "reserve", world.coins.get(token)?.ethReserveWei.toString(), "opened", world.coins.get(token)?.opened);
const cap = (1_000_000_000n * 10n ** 18n * 250n) / 10_000n;
const capOk = bal <= cap && bal >= (cap * 999n) / 1000n; // risk engine sized the buy from the off-chain quote
console.log("filled", bal.toString(), "cap", cap.toString(), "quote-sized fill within 0.1% of cap:", capOk);
if (!launch.ok || !buy.ok || own.ok || !capOk) process.exit(1);
console.log("E2E OK");
