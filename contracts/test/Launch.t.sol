// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {LaunchHook} from "../src/LaunchHook.sol";

contract LaunchTest is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager pm;
    AgentRegistry registry;
    LaunchHook hook;
    PoolSwapTest outsider;
    address owner = makeAddr("owner");
    address session = makeAddr("session");
    address inference = makeAddr("inference");
    address buyback = makeAddr("buyback");
    AgentAccount agent;
    AgentAccount agent2;

    function setUp() public {
        pm = new PoolManager(address(this));
        registry = new AgentRegistry(IPoolManager(address(pm)), ERC20(address(0)), 0);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        );
        address at = address(flags | (uint160(0x4444) << 144));
        deployCodeTo("LaunchHook.sol:LaunchHook", abi.encode(pm, registry, inference, buyback, 4.2 ether, uint64(1 days)), at);
        hook = LaunchHook(payable(at));
        registry.setHook(at);
        outsider = new PoolSwapTest(IPoolManager(address(pm)));

        vm.deal(owner, 100 ether);
        vm.startPrank(owner);
        agent = AgentAccount(payable(registry.create{value: 20 ether}("alpha", "deepseek/v4", bytes32(0), session, 1 ether, 3 ether)));
        agent2 = AgentAccount(payable(registry.create{value: 20 ether}("beta", "qwen/3.8", bytes32(0), session, 10 ether, 50 ether)));
        vm.stopPrank();
    }

    function _launch() internal returns (address token, PoolKey memory key) {
        vm.prank(session);
        token = agent.launch("Alpha Coin", "ALPHA");
        key = hook.keyOf(token);
    }

    function test_agentsCanTradeBeforeOpen_outsidersCannot() public {
        (address token, PoolKey memory key) = _launch();
        vm.prank(session);
        uint256 got = agent2.buy(key, 0.5 ether, 1);
        assertGt(got, 0);
        assertEq(ERC20(token).balanceOf(address(agent2)), got);

        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        outsider.swap{value: 0.1 ether}(
            key,
            SwapParams(true, -0.1 ether, TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function test_opensByTime() public {
        (, PoolKey memory key) = _launch();
        vm.warp(block.timestamp + 1 days);
        vm.deal(address(this), 1 ether);
        outsider.swap{value: 0.1 ether}(key, SwapParams(true, -0.1 ether, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), "");
        (,, bool opened,) = hook.coins(key.toId());
        assertTrue(opened);
    }

    function test_opensByThreshold() public {
        (, PoolKey memory key) = _launch();
        vm.prank(owner); // owner bypasses session caps
        agent2.buy(key, 4.3 ether, 1);
        (,, bool opened, int256 reserve) = hook.coins(key.toId());
        assertTrue(opened);
        assertGe(reserve, 4.2 ether);
    }

    function test_sellRoundTripAndFeeSplit() public {
        (address token, PoolKey memory key) = _launch();
        vm.startPrank(session);
        uint256 got = agent2.buy(key, 1 ether, 1);
        agent2.sell(key, got, 1);
        vm.stopPrank();

        uint256 launcherBefore = address(agent).balance;
        hook.collectFees(token);
        uint256 toLauncher = address(agent).balance - launcherBefore;
        assertApproxEqRel(toLauncher, 0.008 ether, 0.02e18); // 80% of 1% of 1 ETH
        assertApproxEqRel(inference.balance, 0.001 ether, 0.02e18);
        assertApproxEqRel(buyback.balance, 0.001 ether, 0.02e18);
        assertGt(ERC20(token).balanceOf(hook.BURN()), 0); // token-side fees burned
    }

    function test_minOutEnforced() public {
        (, PoolKey memory key) = _launch();
        vm.prank(session);
        vm.expectRevert(AgentAccount.MinOutRequired.selector);
        agent2.buy(key, 0.1 ether, 0);
        vm.prank(session);
        vm.expectRevert();
        agent2.buy(key, 0.1 ether, type(uint256).max);
    }

    function test_sessionCaps() public {
        (, PoolKey memory key) = _launch();
        vm.startPrank(session);
        vm.expectRevert(AgentAccount.OverTradeCap.selector);
        agent.buy(key, 1.5 ether, 1);
        agent.buy(key, 1 ether, 1);
        agent.buy(key, 1 ether, 1);
        agent.buy(key, 1 ether, 1);
        vm.expectRevert(AgentAccount.OverDailyCap.selector);
        agent.buy(key, 0.1 ether, 1);
        vm.stopPrank();
    }

    function test_onlyOwnerMovesFunds() public {
        vm.prank(session);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        agent.withdraw(payable(session), 1 ether);

        uint256 before = owner.balance;
        vm.prank(owner);
        agent.withdraw(payable(owner), 1 ether);
        assertEq(owner.balance, before + 1 ether);
    }

    function test_liquidityIsLocked() public {
        (, PoolKey memory key) = _launch();
        vm.expectRevert();
        pm.initialize(PoolKey(key.currency0, key.currency1, 3000, 60, key.hooks), TickMath.getSqrtPriceAtTick(0));
    }

    function test_nonAgentCannotLaunch_andCooldown() public {
        vm.expectRevert(LaunchHook.NotAgent.selector);
        hook.launch("X", "X");
        _launch();
        vm.prank(session);
        vm.expectRevert(LaunchHook.Cooldown.selector);
        agent.launch("Again", "AGN");
    }
}
