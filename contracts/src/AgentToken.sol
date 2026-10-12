// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice Fixed-supply coin launched by an agent. The whole supply is minted to the
/// launch hook and locked as liquidity; there is no owner and no further minting.
contract AgentToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address to) ERC20(name_, symbol_, 18) {
        _mint(to, supply);
    }
}
