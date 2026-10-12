# Internal security review (pre-audit)

This is a self-review, **not** a substitute for an external audit. Hand this file to the auditor as scope + threat model.

## Tooling run
- Foundry tests: 9 passing (`forge test`) — agent-only gate, open by threshold, open by time, fee split, minOut, session caps, owner-only withdrawals, locked liquidity, launch cooldown.
- Local deploy with CREATE2-mined hook address (`script/Deploy.s.sol`) and an end-to-end runtime test on anvil (`apps/runtime/src/e2e-anvil.ts`).
- Slither 0.11 (medium+): 0 high/medium logic findings. `unchecked-transfer` ×3 fixed (returns now checked). `unused-return` ×9 accepted: PoolManager enforces that every delta is settled before `unlock` returns, so ignored `settle()`/`modifyLiquidity` return values cannot leave debt.

## Trust model
| Role | Can | Cannot |
|---|---|---|
| Agent owner | withdraw all ETH/tokens, rotate session key and caps | — |
| Session key (runtime) | `buy`/`sell` on launch-hook pools within `maxTradeWei` / `dailyLimitWei`, `launch` | transfer funds anywhere, trade other pools, trade with `minOut = 0` |
| Registry deployer | `setHook` once | anything after that |
| Anyone | `collectFees` (pays fixed recipients) | change fee split / recipients (immutable) |

No admin keys, no upgradeability, no pause. Fee split (80/10/10) and recipients are immutable.

## Points for the external auditor
1. `LaunchHook.afterSwap` reserve accounting (`ethReserve -= amount0`) and the opening condition; behaviour with exact-output swaps by outsiders after opening.
2. Single-position liquidity `[minUsableTick, START_TICK]`: rounding dust is burned; confirm no path removes liquidity (hook skips its own callbacks; third-party add/remove/donate/initialize revert).
3. `collectFees` pokes the hook's position with a 0 liquidity delta; confirm fee accounting and that ETH `_pay` to a reverting launcher account cannot brick collection (currently it reverts the whole collect — consider pull payments).
4. Agent-only gate keys on the `sender` passed by PoolManager (= the AgentAccount, since accounts unlock directly). A router can't spoof it.
5. Session daily cap uses `block.timestamp` windows (validator skew is acceptable at day granularity).
6. Sell-side trades are not daily-capped (they only return ETH to the account) — confirm acceptable.
7. Platform-token slot gating reads `balanceOf` at create time only (holding can drop afterwards) — business decision.

## Known decision to revisit
- `_pay` to the launcher pushes ETH; if a launcher account ever became non-payable, fee collection for that coin would revert. AgentAccount has `receive()`, so this cannot happen for registry-created accounts; a pull-payment variant removes the assumption.
