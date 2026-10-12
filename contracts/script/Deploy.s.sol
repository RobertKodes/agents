// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {LaunchHook} from "../src/LaunchHook.sol";

/// env: POOL_MANAGER, PLATFORM_TOKEN (0x0 = no gating), HOLD_PER_SLOT, INFERENCE_POOL, BUYBACK,
///      OPEN_THRESHOLD_WEI, OPEN_WINDOW_SECONDS
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
    );

    function run() external {
        IPoolManager pm = IPoolManager(vm.envAddress("POOL_MANAGER"));
        vm.startBroadcast();
        AgentRegistry registry =
            new AgentRegistry(pm, ERC20(vm.envOr("PLATFORM_TOKEN", address(0))), vm.envOr("HOLD_PER_SLOT", uint256(0)));

        bytes memory initCode = abi.encodePacked(
            type(LaunchHook).creationCode,
            abi.encode(
                pm,
                registry,
                vm.envAddress("INFERENCE_POOL"),
                vm.envAddress("BUYBACK"),
                vm.envOr("OPEN_THRESHOLD_WEI", uint256(4.2 ether)),
                uint64(vm.envOr("OPEN_WINDOW_SECONDS", uint256(1 days)))
            )
        );
        (address predicted, bytes32 salt) = mine(keccak256(initCode));
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && predicted.code.length > 0, "hook deploy failed");
        registry.setHook(predicted);
        vm.stopBroadcast();

        console2.log("AgentRegistry", address(registry));
        console2.log("LaunchHook", predicted);
    }

    function mine(bytes32 initCodeHash) internal pure returns (address, bytes32) {
        uint160 mask = Hooks.ALL_HOOK_MASK;
        for (uint256 i; i < 500_000; ++i) {
            bytes32 salt = bytes32(i);
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)))));
            if (uint160(a) & mask == FLAGS) return (a, salt);
        }
        revert("no salt found");
    }
}
