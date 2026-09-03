// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// @notice tclk/1 `evm-htlc` settlement rail (SPEC.md §5) — hash-lock only (`Predicate::Hash`).
/// Point-lock (`t*G == Y`) is a separate contract, out of scope here.
///
/// One lock per `hashLock`. `hashLock` is the 32-byte sha256 statement tclk already computes
/// off-chain (`generateHashLock`/`verifySecret` in src/locks.ts) — this contract enforces the
/// exact same predicate on-chain, using the `sha256` precompile so both sides agree byte-for-byte.
///
/// Deadlines (`claimByMs`/`refundAfterMs`) are ms-epoch, matching tclk's `LockTerms` exactly —
/// this contract never rescales them. Every on-chain comparison instead scales `block.timestamp`
/// (seconds) up by 1000, so the ms values passed in are stored and compared unmodified.
contract EvmHashRail {
    enum Status {
        None,
        Locked,
        Claimed,
        Refunded
    }

    struct Lock {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 claimByMs;
        uint256 refundAfterMs;
        Status status;
    }

    mapping(bytes32 => Lock) public locks;

    event Locked(
        bytes32 indexed hashLock,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        uint256 claimByMs,
        uint256 refundAfterMs
    );
    event Claimed(bytes32 indexed hashLock, bytes32 preimage);
    event Refunded(bytes32 indexed hashLock);

    /// @notice Escrow `amount` of `token` under `hashLock`, callable by the payer.
    /// Pulls funds via `transferFrom` — the payer must approve this contract first.
    function lock(
        bytes32 hashLock,
        address payee,
        uint256 amount,
        address token,
        uint256 claimByMs,
        uint256 refundAfterMs
    ) external {
        require(locks[hashLock].status == Status.None, "EvmHashRail: lock exists");
        require(payee != address(0), "EvmHashRail: payee is zero address");
        require(amount > 0, "EvmHashRail: amount is zero");
        require(claimByMs < refundAfterMs, "EvmHashRail: claimByMs must precede refundAfterMs");
        require(
            block.timestamp * 1000 < refundAfterMs,
            "EvmHashRail: refusing to lock into an already-open refund window"
        );

        locks[hashLock] = Lock({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            claimByMs: claimByMs,
            refundAfterMs: refundAfterMs,
            status: Status.Locked
        });

        emit Locked(hashLock, msg.sender, payee, token, amount, claimByMs, refundAfterMs);

        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "EvmHashRail: transferFrom failed"
        );
    }

    /// @notice Release to the payee. Permissionless — anyone may relay the preimage, funds
    /// only ever move to the `payee` address recorded at lock time.
    function claim(bytes32 hashLock, bytes32 preimage) external {
        Lock storage held = locks[hashLock];
        require(held.status != Status.None, "EvmHashRail: claim on an unknown lock");
        require(held.status == Status.Locked, "EvmHashRail: claim on a lock that is not locked");
        require(block.timestamp * 1000 < held.refundAfterMs, "EvmHashRail: claim after refundAfterMs");
        require(sha256(abi.encodePacked(preimage)) == hashLock, "EvmHashRail: secret does not open the statement");

        held.status = Status.Claimed;
        emit Claimed(hashLock, preimage);

        require(IERC20(held.token).transfer(held.payee, held.amount), "EvmHashRail: transfer failed");
    }

    /// @notice Return to the payer, only at/after `refundAfterMs`, only the payer.
    function refund(bytes32 hashLock) external {
        Lock storage held = locks[hashLock];
        require(held.status != Status.None, "EvmHashRail: refund on an unknown lock");
        require(held.status == Status.Locked, "EvmHashRail: refund on a lock that is not locked");
        require(msg.sender == held.payer, "EvmHashRail: only the payer refunds");
        require(block.timestamp * 1000 >= held.refundAfterMs, "EvmHashRail: refund before refundAfterMs");

        held.status = Status.Refunded;
        emit Refunded(hashLock);

        require(IERC20(held.token).transfer(held.payer, held.amount), "EvmHashRail: transfer failed");
    }
}
