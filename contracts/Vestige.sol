// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/**
 * @title Vestige
 * @notice Verifies that two P-256 keys co-signed a recent block hash.
 *
 * A signer signs a statement bound to a recent block hash. A cosigner (a WebAuthn passkey) signs a
 * challenge derived from that statement and the signer's key. Accepting both proves the cosigner
 * acted after block `blockNumber` was produced, before the transaction was included, and over this
 * exact statement from this exact signer.
 *
 * The signer may sign with a raw P-256 key (e.g. a WebCrypto key on an unattended device) or with a
 * WebAuthn passkey. The contract only distinguishes signature formats; how a deployment presents
 * them to people is up to the application.
 *
 * P-256 verification uses the RIP-7212 / EIP-7951 precompile when present and falls back to
 * OpenZeppelin's Solidity implementation otherwise. Signatures must be low-s (s <= n/2); clients
 * normalize WebCrypto/WebAuthn output with s' = n - s.
 *
 * The signer declares the statement's window (`maxAge`, in blocks) inside what it signs, so neither the
 * relayer nor the cosigner can stretch it. Anchors up to 256 blocks old are checked with `blockhash`; older
 * ones (up to 8191) are read from the EIP-2935 history contract, so windows above 256 need a chain that has it.
 *
 * The contract has no constructor arguments and no admin: the same build deploys to the same CREATE2
 * address on every chain.
 */
contract Vestige {
    enum SignatureKind {
        P256, // raw ECDSA over sha256(statementMessage): WebCrypto `sign({name: "ECDSA", hash: "SHA-256"}, ...)`
        WebAuthn // WebAuthn assertion whose challenge is statementDigest
    }

    struct PublicKey {
        bytes32 x;
        bytes32 y;
    }

    /// @dev `maxAge` is the signer's window: the cosign must land at most `maxAge` blocks after `blockNumber`.
    /// `signature` is `r ‖ s` (64 bytes) for `P256`, or the flat ABI encoding of a
    /// `WebAuthn.WebAuthnAuth` (`abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON)`)
    /// for `WebAuthn`.
    struct Statement {
        PublicKey signer;
        SignatureKind kind;
        uint256 blockNumber;
        bytes32 blockHash;
        uint256 maxAge;
        bytes signature;
    }

    bytes32 public constant STATEMENT_TAG = keccak256("vestige.statement.v2");
    bytes32 public constant COSIGN_TAG = keccak256("vestige.cosign.v1");

    /// @notice EIP-2935 system contract serving the last 8191 block hashes.
    address public constant HISTORY_STORAGE = 0x0000F90827F1C53a10cb7A02335B175320002935;
    /// @notice Largest window a statement may declare: the EIP-2935 serve window.
    uint256 public constant MAX_AGE_LIMIT = 8191;
    /// @notice WebAuthn assertions (cosigner, and a passkey signer) must carry the UV (biometric/PIN) flag.
    bool public constant REQUIRE_USER_VERIFICATION = true;

    /// @notice Cosign ids already recorded. One per (statement, signer key, cosigner key).
    mapping(bytes32 cosignId => bool) public recorded;

    event Cosigned(
        bytes32 indexed cosignId,
        bytes32 indexed signerKey,
        bytes32 indexed cosignerKey,
        SignatureKind signerKind,
        uint256 blockNumber,
        bytes32 blockHash,
        uint256 maxAge,
        uint256 age
    );

    error InvalidMaxAge(uint256 maxAge);
    error StaleBlock(uint256 blockNumber);
    error BlockHashUnavailable(uint256 blockNumber);
    error BlockHashMismatch();
    error SelfCosign();
    error MalformedSignature();
    error InvalidSignerSignature();
    error InvalidCosignerSignature();
    error AlreadyRecorded(bytes32 cosignId);

    /// @notice Verifies a co-signature and records it on-chain. Anyone may submit; the signatures authorize.
    function cosign(
        Statement calldata statement,
        PublicKey calldata cosigner,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (bytes32 cosignId, uint256 age) {
        (cosignId, age) = verify(statement, cosigner, auth);
        if (recorded[cosignId]) revert AlreadyRecorded(cosignId);
        recorded[cosignId] = true;
        emit Cosigned(
            cosignId,
            keyId(statement.signer),
            keyId(cosigner),
            statement.kind,
            statement.blockNumber,
            statement.blockHash,
            statement.maxAge,
            age
        );
    }

    /// @notice Verifies a co-signature without recording it. Reverts with the failing check. `age` is how many
    /// blocks after the anchor this call runs; consumers may enforce a tighter window than the signer's.
    function verify(
        Statement calldata statement,
        PublicKey calldata cosigner,
        WebAuthn.WebAuthnAuth calldata auth
    ) public view returns (bytes32 cosignId, uint256 age) {
        uint256 n = statement.blockNumber;
        uint256 maxAge = statement.maxAge;
        if (maxAge == 0 || maxAge > MAX_AGE_LIMIT) revert InvalidMaxAge(maxAge);
        if (n >= block.number || block.number - n > maxAge) revert StaleBlock(n);
        age = block.number - n;
        bytes32 anchorHash = _blockHash(n);
        if (anchorHash == bytes32(0)) revert BlockHashUnavailable(n);
        if (anchorHash != statement.blockHash) revert BlockHashMismatch();
        if (keyId(statement.signer) == keyId(cosigner)) revert SelfCosign();

        bytes32 digest = statementDigest(n, statement.blockHash, maxAge);
        if (!_verifySigner(statement, digest)) revert InvalidSignerSignature();

        bytes memory challenge = abi.encodePacked(cosignChallenge(digest, statement.signer));
        if (!WebAuthn.verify(challenge, auth, cosigner.x, cosigner.y, REQUIRE_USER_VERIFICATION)) {
            revert InvalidCosignerSignature();
        }

        cosignId = keccak256(abi.encode(digest, statement.signer, cosigner));
    }

    /// @notice Bytes behind the statement digest. Domain-separated by chain and contract to stop cross-deployment
    /// replay; includes the signer's window so it cannot be changed after signing.
    function statementMessage(uint256 blockNumber, bytes32 blockHash, uint256 maxAge) public view returns (bytes memory) {
        return abi.encode(STATEMENT_TAG, block.chainid, address(this), blockNumber, blockHash, maxAge);
    }

    /// @notice What the signer signs: the P-256 message hash, or the WebAuthn challenge for a passkey signer.
    function statementDigest(uint256 blockNumber, bytes32 blockHash, uint256 maxAge) public view returns (bytes32) {
        return sha256(statementMessage(blockNumber, blockHash, maxAge));
    }

    /// @notice 32-byte WebAuthn challenge the cosigner signs. Binds the statement and signer key rather than the
    /// signer's signature bytes, which are non-deterministic and malleable (high/low s). Always differs from the
    /// statement digest, so a signer's assertion can never pass as a cosigner's or vice versa.
    function cosignChallenge(bytes32 digest, PublicKey calldata signer) public pure returns (bytes32) {
        return keccak256(abi.encode(COSIGN_TAG, digest, signer));
    }

    function keyId(PublicKey calldata key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @dev Hash of past block `n`: `blockhash` within 256 blocks, the EIP-2935 history contract beyond.
    /// Zero when neither can serve it (history contract missing or reverting).
    function _blockHash(uint256 n) private view returns (bytes32) {
        if (block.number - n <= 256) return blockhash(n);
        (bool ok, bytes memory data) = HISTORY_STORAGE.staticcall(abi.encode(n));
        return ok && data.length == 32 ? bytes32(data) : bytes32(0);
    }

    function _verifySigner(Statement calldata statement, bytes32 digest) private view returns (bool) {
        bytes calldata signature = statement.signature;
        if (statement.kind == SignatureKind.P256) {
            if (signature.length != 64) revert MalformedSignature();
            return P256.verify(digest, bytes32(signature[:32]), bytes32(signature[32:]), statement.signer.x, statement.signer.y);
        }
        (bool ok, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(signature);
        if (!ok) revert MalformedSignature();
        return WebAuthn.verify(abi.encodePacked(digest), auth, statement.signer.x, statement.signer.y, REQUIRE_USER_VERIFICATION);
    }
}
