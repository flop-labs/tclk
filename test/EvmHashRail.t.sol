// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EvmHashRail} from "../contracts/EvmHashRail.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract EvmHashRailTest is Test {
    EvmHashRail rail;
    MockERC20 token;

    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");

    bytes32 preimage = keccak256("tclk-issue12-and-friends");
    bytes32 hashLock;

    uint256 amount = 1_000_000;
    uint256 claimByMs;
    uint256 refundAfterMs;

    function setUp() public {
        rail = new EvmHashRail();
        token = new MockERC20();
        hashLock = sha256(abi.encodePacked(preimage));

        // Anchor deadlines to the current block time (in ms) so the test doesn't depend on
        // when it happens to run.
        claimByMs = block.timestamp * 1000 + 3_600_000;
        refundAfterMs = block.timestamp * 1000 + 7_200_000;

        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(rail), amount);
    }

    function _lock() internal {
        vm.prank(payer);
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }

    // --- happy path ---

    function test_lockThenClaim_movesFundsToPayee() public {
        _lock();
        assertEq(token.balanceOf(address(rail)), amount);
        assertEq(token.balanceOf(payer), 0);

        rail.claim(hashLock, preimage);

        assertEq(token.balanceOf(payee), amount);
        assertEq(token.balanceOf(address(rail)), 0);
        (,,,,,, EvmHashRail.Status status) = rail.locks(hashLock);
        assertEq(uint8(status), uint8(EvmHashRail.Status.Claimed));
    }

    function test_claim_isPermissionless() public {
        _lock();
        vm.prank(stranger);
        rail.claim(hashLock, preimage);
        assertEq(token.balanceOf(payee), amount);
    }

    // --- claim guards ---

    function test_claim_withWrongPreimage_reverts() public {
        _lock();
        vm.expectRevert("EvmHashRail: secret does not open the statement");
        rail.claim(hashLock, keccak256("wrong secret"));
    }

    function test_claim_afterRefundWindowOpens_reverts() public {
        _lock();
        vm.warp(refundAfterMs / 1000);
        vm.expectRevert("EvmHashRail: claim after refundAfterMs");
        rail.claim(hashLock, preimage);
    }

    function test_claim_onUnknownLock_reverts() public {
        vm.expectRevert("EvmHashRail: claim on an unknown lock");
        rail.claim(bytes32(uint256(0xdead)), preimage);
    }

    function test_claim_afterAlreadyRefunded_reverts() public {
        _lock();
        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        rail.refund(hashLock);

        vm.expectRevert("EvmHashRail: claim on a lock that is not locked");
        rail.claim(hashLock, preimage);
    }

    // --- refund guards ---

    function test_refund_beforeWindow_reverts() public {
        _lock();
        vm.prank(payer);
        vm.expectRevert("EvmHashRail: refund before refundAfterMs");
        rail.refund(hashLock);
    }

    function test_refund_atBoundary_succeeds() public {
        _lock();
        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        rail.refund(hashLock);
        assertEq(token.balanceOf(payer), amount);
    }

    function test_refund_byNonPayer_reverts() public {
        _lock();
        vm.warp(refundAfterMs / 1000);
        vm.expectRevert("EvmHashRail: only the payer refunds");
        vm.prank(stranger);
        rail.refund(hashLock);
    }

    function test_refund_afterAlreadyClaimed_reverts() public {
        _lock();
        rail.claim(hashLock, preimage);

        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        vm.expectRevert("EvmHashRail: refund on a lock that is not locked");
        rail.refund(hashLock);
    }

    function test_refund_onUnknownLock_reverts() public {
        vm.expectRevert("EvmHashRail: refund on an unknown lock");
        rail.refund(bytes32(uint256(0xdead)));
    }

    // --- lock guards ---

    function test_lock_duplicateHashLock_reverts() public {
        _lock();
        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(rail), amount);

        vm.prank(payer);
        vm.expectRevert("EvmHashRail: lock exists");
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }

    function test_lock_intoAlreadyOpenRefundWindow_reverts() public {
        vm.warp(refundAfterMs / 1000);
        vm.prank(payer);
        vm.expectRevert("EvmHashRail: refusing to lock into an already-open refund window");
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }

    function test_lock_withoutAllowance_reverts() public {
        vm.prank(payer);
        token.approve(address(rail), 0);
        vm.prank(payer);
        vm.expectRevert("MockERC20: insufficient allowance");
        rail.lock(hashLock, payee, amount, address(token), claimByMs, refundAfterMs);
    }
}
