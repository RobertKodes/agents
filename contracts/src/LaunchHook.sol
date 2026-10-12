// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {AgentToken} from "./AgentToken.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @notice Launch pad for agent coins on Uniswap v4.
/// - Each coin's full supply is single-sided liquidity owned by this hook, locked forever.
/// - Until a coin opens only registered agent accounts may swap. It opens when the ETH
///   in the pool reaches `openThresholdWei` OR when `opensAt` passes — both enforced here.
/// - The pool fee (1%) accrues to the hook's position; `collectFees` splits ETH fees with
///   fixed shares (launcher agent / inference pool / buyback) and burns token fees.
contract LaunchHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint24 public constant FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    int24 public constant START_TICK = 204_200; // ≈ 1.35e-9 ETH per token at launch
    uint256 public constant LAUNCHER_BPS = 8_000;
    uint256 public constant INFERENCE_BPS = 1_000; // remainder goes to buyback
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    AgentRegistry public immutable registry;
    address public immutable inferencePool;
    address public immutable buyback;
    uint256 public immutable openThresholdWei;
    uint64 public immutable openWindow;

    struct Coin {
        address launcher;
        uint64 opensAt;
        bool opened;
        int256 ethReserve;
    }

    mapping(PoolId => Coin) public coins;
    mapping(address token => PoolKey) internal _keyOf;
    mapping(address launcher => uint256) public lastLaunchAt;
    uint256 public constant LAUNCH_COOLDOWN = 1 hours;

    event Launched(address indexed token, address indexed launcher, PoolId indexed id, string name, string symbol, uint64 opensAt);
    event Opened(PoolId indexed id, bool byThreshold);
    event FeesCollected(PoolId indexed id, uint256 eth, uint256 tokensBurned, uint256 toLauncher, uint256 toInference, uint256 toBuyback);

    error NotPoolManager();
    error NotAgent();
    error Locked();
    error Cooldown();
    error UnknownPool();

    enum Action {
        Add,
        Collect
    }

    constructor(
        IPoolManager pm,
        AgentRegistry registry_,
        address inferencePool_,
        address buyback_,
        uint256 openThresholdWei_,
        uint64 openWindow_
    ) {
        poolManager = pm;
        registry = registry_;
        inferencePool = inferencePool_;
        buyback = buyback_;
        openThresholdWei = openThresholdWei_;
        openWindow = openWindow_;
        Hooks.validateHookPermissions(IHooks(address(this)), permissions());
    }

    function permissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeDonate = true;
    }

    function keyOf(address token) external view returns (PoolKey memory) {
        return _keyOf[token];
    }

    function isOpen(PoolId id) public view returns (bool) {
        Coin storage c = coins[id];
        return c.opened || (c.launcher != address(0) && block.timestamp >= c.opensAt);
    }

    // ---------------------------------------------------------------- launch

    function launch(string calldata name, string calldata symbol) external returns (address token, PoolKey memory key) {
        if (!registry.isAgent(msg.sender)) revert NotAgent();
        if (block.timestamp < lastLaunchAt[msg.sender] + LAUNCH_COOLDOWN && lastLaunchAt[msg.sender] != 0) revert Cooldown();
        lastLaunchAt[msg.sender] = block.timestamp;

        token = address(new AgentToken(name, symbol, SUPPLY, address(this)));
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(token), FEE, TICK_SPACING, IHooks(address(this)));
        PoolId id = key.toId();
        uint64 opensAt = uint64(block.timestamp) + openWindow;
        coins[id] = Coin(msg.sender, opensAt, false, 0);
        _keyOf[token] = key;

        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(START_TICK));
        poolManager.unlock(abi.encode(Action.Add, key));
        emit Launched(token, msg.sender, id, name, symbol, opensAt);
    }

    function collectFees(address token) external {
        PoolKey memory key = _keyOf[token];
        if (address(key.hooks) == address(0)) revert UnknownPool();
        poolManager.unlock(abi.encode(Action.Collect, key));
    }

    function _range() internal pure returns (int24 lower, int24 upper) {
        lower = TickMath.minUsableTick(TICK_SPACING);
        upper = START_TICK;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, PoolKey memory key) = abi.decode(data, (Action, PoolKey));
        (int24 lower, int24 upper) = _range();

        if (action == Action.Add) {
            uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), SUPPLY
            );
            (BalanceDelta delta,) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), 0), ""
            );
            uint256 owed = uint256(uint128(-delta.amount1()));
            poolManager.sync(key.currency1);
            require(AgentToken(Currency.unwrap(key.currency1)).transfer(address(poolManager), owed), "transfer");
            poolManager.settle();
            uint256 dust = AgentToken(Currency.unwrap(key.currency1)).balanceOf(address(this));
            if (dust > 0) require(AgentToken(Currency.unwrap(key.currency1)).transfer(BURN, dust), "transfer");
        } else {
            (, BalanceDelta fees) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, 0, 0), "");
            uint256 eth = uint256(uint128(fees.amount0()));
            uint256 tok = uint256(uint128(fees.amount1()));
            if (tok > 0) poolManager.take(key.currency1, BURN, tok);
            if (eth > 0) {
                poolManager.take(key.currency0, address(this), eth);
                PoolId id = key.toId();
                uint256 toLauncher = (eth * LAUNCHER_BPS) / 10_000;
                uint256 toInference = (eth * INFERENCE_BPS) / 10_000;
                uint256 toBuyback = eth - toLauncher - toInference;
                _pay(coins[id].launcher, toLauncher);
                _pay(inferencePool, toInference);
                _pay(buyback, toBuyback);
                emit FeesCollected(id, eth, tok, toLauncher, toInference, toBuyback);
            }
        }
        return "";
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pay failed");
    }

    receive() external payable {}

    // ---------------------------------------------------------------- hooks

    modifier onlyPM() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    // Pool manager skips hooks when the hook itself is the caller, so these only
    // ever see third parties: nobody else can create pools, add, remove or donate.
    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPM returns (bytes4) {
        revert Locked();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPM
        returns (bytes4)
    {
        revert Locked();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPM
        returns (bytes4)
    {
        revert Locked();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external view onlyPM returns (bytes4) {
        revert Locked();
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyPM
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        Coin storage c = coins[id];
        if (!c.opened) {
            if (block.timestamp >= c.opensAt) {
                c.opened = true;
                emit Opened(id, false);
            } else if (!registry.isAgent(sender)) {
                revert NotAgent();
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata)
        external
        onlyPM
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        Coin storage c = coins[id];
        c.ethReserve -= int256(delta.amount0()); // swapper pays ETH => amount0 < 0 => reserve grows
        if (!c.opened && c.ethReserve >= int256(openThresholdWei)) {
            c.opened = true;
            emit Opened(id, true);
        }
        return (IHooks.afterSwap.selector, 0);
    }

    // Unused callbacks (permission bits off; never called).
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert Locked();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert Locked();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert Locked();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert Locked();
    }
}
