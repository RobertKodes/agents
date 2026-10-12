// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {AgentAccount} from "./AgentAccount.sol";

/// @notice Creates agents and their non-custodial accounts. The model is locked at
/// creation. Agent slots are gated by holding the platform token.
contract AgentRegistry {
    struct Profile {
        address owner;
        string handle;
        string modelId;
        bytes32 profileHash; // IPFS hash of persona + plan
    }

    IPoolManager public immutable poolManager;
    ERC20 public immutable platformToken;
    uint256 public immutable holdPerSlot;
    address private immutable deployer;

    address public hook;
    mapping(address account => bool) public isAgent;
    mapping(bytes32 handleHash => address) public accountOf;
    mapping(address account => Profile) internal _profiles;
    mapping(address owner => uint256) public slotsUsed;

    event AgentCreated(address indexed account, address indexed owner, string handle, string modelId, bytes32 profileHash);

    error HookAlreadySet();
    error BadHandle();
    error HandleTaken();
    error NotEnoughPlatformToken(uint256 required, uint256 held);

    constructor(IPoolManager pm, ERC20 token, uint256 holdPerSlot_) {
        poolManager = pm;
        platformToken = token;
        holdPerSlot = holdPerSlot_;
        deployer = msg.sender;
    }

    /// One-time wiring after the hook is deployed at its flag address.
    function setHook(address hook_) external {
        if (msg.sender != deployer || hook != address(0)) revert HookAlreadySet();
        hook = hook_;
    }

    function profile(address account) external view returns (Profile memory) {
        return _profiles[account];
    }

    function create(
        string calldata handle,
        string calldata modelId,
        bytes32 profileHash,
        address sessionKey,
        uint256 maxTradeWei,
        uint256 dailyLimitWei
    ) external payable returns (address account) {
        bytes memory h = bytes(handle);
        if (h.length < 2 || h.length > 15) revert BadHandle();
        for (uint256 i; i < h.length; ++i) {
            bytes1 c = h[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9"))) revert BadHandle();
        }
        bytes32 key = keccak256(h);
        if (accountOf[key] != address(0)) revert HandleTaken();

        uint256 required = (slotsUsed[msg.sender] + 1) * holdPerSlot;
        uint256 held = address(platformToken) == address(0) ? type(uint256).max : platformToken.balanceOf(msg.sender);
        if (held < required) revert NotEnoughPlatformToken(required, held);
        slotsUsed[msg.sender]++;

        account = address(new AgentAccount{value: msg.value}(msg.sender, this, poolManager, sessionKey, maxTradeWei, dailyLimitWei));
        isAgent[account] = true;
        accountOf[key] = account;
        _profiles[account] = Profile(msg.sender, handle, modelId, profileHash);
        emit AgentCreated(account, msg.sender, handle, modelId, profileHash);
    }
}
