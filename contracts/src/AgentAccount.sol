// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

interface ILaunchHook {
    function launch(string calldata name, string calldata symbol) external returns (address token, PoolKey memory key);
}

/// @notice An agent's wallet. The owner can always withdraw everything. The session
/// key (the agent runtime) can only trade on launch-hook pools and launch coins,
/// within per-trade and per-day caps, and every trade enforces a minimum output.
/// There is no function that lets anyone but the owner move funds out.
contract AgentAccount is IUnlockCallback {
    address public immutable owner;
    AgentRegistry public immutable registry;
    IPoolManager public immutable poolManager;

    address public sessionKey;
    uint256 public maxTradeWei;
    uint256 public dailyLimitWei;
    uint256 public spentToday;
    uint256 public dayStart;

    event SessionSet(address key, uint256 maxTradeWei, uint256 dailyLimitWei);
    event Traded(address indexed token, bool buy, uint256 amountIn, uint256 amountOut);
    event Withdrawn(address indexed asset, address to, uint256 amount);

    error NotOwner();
    error NotAuthorized();
    error NotHookPool();
    error OverTradeCap();
    error OverDailyCap();
    error Slippage(uint256 out, uint256 minOut);
    error MinOutRequired();
    error TransferFailed();

    struct SwapData {
        PoolKey key;
        bool buy;
        uint256 amountIn;
        uint256 minOut;
    }

    constructor(address owner_, AgentRegistry registry_, IPoolManager pm, address session, uint256 maxTrade, uint256 daily)
        payable
    {
        owner = owner_;
        registry = registry_;
        poolManager = pm;
        _setSession(session, maxTrade, daily);
    }

    receive() external payable {}

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && msg.sender != sessionKey) revert NotAuthorized();
        _;
    }

    function setSession(address key, uint256 maxTrade, uint256 daily) external onlyOwner {
        _setSession(key, maxTrade, daily);
    }

    function _setSession(address key, uint256 maxTrade, uint256 daily) internal {
        sessionKey = key;
        maxTradeWei = maxTrade;
        dailyLimitWei = daily;
        emit SessionSet(key, maxTrade, daily);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(address(0), to, amount);
    }

    function withdrawToken(ERC20 token, address to, uint256 amount) external onlyOwner {
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(address(token), to, amount);
    }

    function launch(string calldata name, string calldata symbol) external onlyOperator returns (address token) {
        (token,) = ILaunchHook(registry.hook()).launch(name, symbol);
    }

    function buy(PoolKey calldata key, uint256 ethIn, uint256 minTokensOut) external onlyOperator returns (uint256 out) {
        if (msg.sender != owner) {
            if (ethIn > maxTradeWei) revert OverTradeCap();
            if (block.timestamp >= dayStart + 1 days) (dayStart, spentToday) = (block.timestamp, 0);
            if (spentToday + ethIn > dailyLimitWei) revert OverDailyCap();
            spentToday += ethIn;
        }
        out = _swap(SwapData(key, true, ethIn, minTokensOut));
    }

    function sell(PoolKey calldata key, uint256 tokensIn, uint256 minEthOut) external onlyOperator returns (uint256 out) {
        out = _swap(SwapData(key, false, tokensIn, minEthOut));
    }

    function _swap(SwapData memory d) internal returns (uint256 out) {
        if (address(d.key.hooks) != registry.hook()) revert NotHookPool();
        if (d.minOut == 0) revert MinOutRequired();
        out = abi.decode(poolManager.unlock(abi.encode(d)), (uint256));
        emit Traded(Currency.unwrap(d.key.currency1), d.buy, d.amountIn, out);
    }

    /// Pool is always ETH (currency0) / token (currency1): buy = zeroForOne.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotAuthorized();
        SwapData memory d = abi.decode(data, (SwapData));
        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.buy,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: d.buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        uint256 out;
        if (d.buy) {
            poolManager.settle{value: uint256(uint128(-a0))}();
            out = uint256(uint128(a1));
            poolManager.take(d.key.currency1, address(this), out);
        } else {
            poolManager.sync(d.key.currency1);
            if (!ERC20(Currency.unwrap(d.key.currency1)).transfer(address(poolManager), uint256(uint128(-a1)))) revert TransferFailed();
            poolManager.settle();
            out = uint256(uint128(a0));
            poolManager.take(d.key.currency0, address(this), out);
        }
        if (out < d.minOut) revert Slippage(out, d.minOut);
        return abi.encode(out);
    }
}
