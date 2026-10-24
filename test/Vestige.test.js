const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine, setCode, setStorageAt } = require("@nomicfoundation/hardhat-network-helpers");
const crypto = require("node:crypto");
const { N, generateKey, sign, webauthnAssert } = require("./helpers/p256");

const MAX_AGE = 32;
const P256 = 0;
const WEBAUTHN = 1;
const coder = ethers.AbiCoder.defaultAbiCoder();
const sha256 = (data) => "0x" + crypto.createHash("sha256").update(data).digest("hex");

// Client-side encodings; the first test checks they match the contract's view functions.
async function statementMessage(vestige, blockNumber, blockHash, maxAge) {
  const { chainId } = await ethers.provider.getNetwork();
  return coder.encode(
    ["bytes32", "uint256", "address", "uint256", "bytes32", "uint256"],
    [ethers.id("vestige.statement.v2"), chainId, await vestige.getAddress(), blockNumber, blockHash, maxAge],
  );
}

function cosignChallenge(digest, key) {
  return ethers.keccak256(
    coder.encode(["bytes32", "bytes32", "bytes32", "bytes32"], [ethers.id("vestige.cosign.v1"), digest, key.x, key.y]),
  );
}

// Flat ABI encoding of WebAuthn.WebAuthnAuth, as WebAuthn.tryDecodeAuth expects.
const encodeAuth = (a) =>
  coder.encode(
    ["bytes32", "bytes32", "uint256", "uint256", "bytes", "string"],
    [a.r, a.s, a.challengeIndex, a.typeIndex, a.authenticatorData, a.clientDataJSON],
  );

// Signer signs the latest block (or an override) with a window of `maxAge` blocks, as a raw P-256 key (Beacon) or a
// passkey (Handshake); the cosigner co-signs via WebAuthn.
async function makeCosign(vestige, signerKey, cosignerKey, opts = {}) {
  const kind = opts.kind ?? P256;
  const latest = await ethers.provider.getBlock("latest");
  const blockNumber = opts.blockNumber ?? latest.number;
  const blockHash = opts.blockHash ?? (await ethers.provider.getBlock(blockNumber)).hash;
  const maxAge = opts.maxAge ?? MAX_AGE;
  const message = ethers.getBytes(await statementMessage(opts.target ?? vestige, blockNumber, blockHash, maxAge));
  const digest = sha256(message);

  let signature, signerAuth;
  if (kind === P256) {
    const { r, s } = sign(signerKey.privateKey, message);
    signature = ethers.concat([r, s]);
  } else {
    signerAuth = webauthnAssert(signerKey.privateKey, opts.signerChallenge ?? digest, opts.signerAssert);
    signature = encodeAuth(signerAuth);
  }
  const statement = { signer: signerKey.pub, kind, blockNumber, blockHash, maxAge, signature };
  const challenge = opts.challenge ?? cosignChallenge(digest, signerKey.pub);
  const auth = webauthnAssert(cosignerKey.privateKey, challenge, opts.assert);
  return { statement, cosigner: cosignerKey.pub, auth, digest, signerAuth };
}

// EIP-2935 history contract, runtime bytecode as deployed on Ethereum mainnet. Hardhat 2 ships a stub that reverts
// (NomicFoundation/hardhat#6226) and never writes history, so tests install the real code and store the hashes
// the protocol's per-block system call would have written (slot = number % 8191).
const HISTORY_STORAGE = "0x0000F90827F1C53a10cb7A02335B175320002935";
const HISTORY_CODE =
  "0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";
async function recordHistory(blockNumber) {
  await setCode(HISTORY_STORAGE, HISTORY_CODE);
  await setStorageAt(HISTORY_STORAGE, blockNumber % 8191, (await ethers.provider.getBlock(blockNumber)).hash);
}

const keyId = (key) => ethers.keccak256(coder.encode(["bytes32", "bytes32"], [key.x, key.y]));

describe("Vestige", function () {
  async function deploy() {
    const Vestige = await ethers.getContractFactory("Vestige");
    const vestige = await Vestige.deploy();
    await mine(2);
    return { Vestige, vestige, signerKey: generateKey(), cosignerKey: generateKey() };
  }

  describe("encoding", function () {
    it("matches client-side statement message, digest and cosign challenge", async function () {
      const { vestige, signerKey } = await loadFixture(deploy);
      const block = await ethers.provider.getBlock("latest");
      const message = await statementMessage(vestige, block.number, block.hash, MAX_AGE);
      const digest = sha256(ethers.getBytes(message));
      expect(await vestige.statementMessage(block.number, block.hash, MAX_AGE)).to.equal(message);
      expect(await vestige.statementDigest(block.number, block.hash, MAX_AGE)).to.equal(digest);
      expect(await vestige.cosignChallenge(digest, signerKey.pub)).to.equal(cosignChallenge(digest, signerKey.pub));
      expect(await vestige.keyId(signerKey.pub)).to.equal(keyId(signerKey.pub));
    });
  });

  for (const [mode, kind] of [["P256 signer (Beacon)", P256], ["WebAuthn signer (Handshake)", WEBAUTHN]]) {
    describe(mode, function () {
      it("records a valid co-signature and emits Cosigned with the signer kind, window and age", async function () {
        const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
        const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { kind });
        await mine(1); // eth_call executes at the head block, so the anchor must already be behind it
        const [cosignId] = await vestige.verify(statement, cosigner, auth);

        const tx = await vestige.cosign(statement, cosigner, auth);
        const age = (await tx.wait()).blockNumber - statement.blockNumber;
        await expect(tx)
          .to.emit(vestige, "Cosigned")
          .withArgs(cosignId, keyId(signerKey.pub), keyId(cosignerKey.pub), kind, statement.blockNumber, statement.blockHash, MAX_AGE, age);
        expect(await vestige.recorded(cosignId)).to.equal(true);
        console.log(`      cosign gas: ${(await tx.wait()).gasUsed} (P256_PRECOMPILE=${process.env.P256_PRECOMPILE ?? "1"})`);
      });

      it("rejects a signature from a different signer key", async function () {
        const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
        const { statement, cosigner, auth } = await makeCosign(vestige, generateKey(), cosignerKey, {
          kind,
          challenge: cosignChallenge((await makeCosign(vestige, signerKey, cosignerKey)).digest, signerKey.pub),
        });
        statement.signer = signerKey.pub;
        await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidSignerSignature");
      });

      it("rejects a signer key that is also the cosigner", async function () {
        const { vestige, signerKey } = await loadFixture(deploy);
        const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, signerKey, { kind });
        await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "SelfCosign");
      });
    });
  }

  describe("P256 signer", function () {
    it("lets many cosigners co-sign the same statement", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const blockNumber = (await ethers.provider.getBlock("latest")).number;
      const a = await makeCosign(vestige, signerKey, cosignerKey, { blockNumber });
      const b = await makeCosign(vestige, signerKey, generateKey(), { blockNumber });
      await vestige.cosign(a.statement, a.cosigner, a.auth);
      await expect(vestige.cosign(b.statement, b.cosigner, b.auth)).to.emit(vestige, "Cosigned");
    });

    it("rejects a high-s signature", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      const r = ethers.dataSlice(statement.signature, 0, 32);
      const s = BigInt(ethers.dataSlice(statement.signature, 32));
      statement.signature = ethers.concat([r, ethers.toBeHex(N - s, 32)]);
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidSignerSignature");
    });

    it("rejects a signature that is not 64 bytes", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      statement.signature = ethers.concat([statement.signature, "0x00"]);
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "MalformedSignature");
    });
  });

  describe("WebAuthn signer", function () {
    it("requires user verification on the signer when configured", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        kind: WEBAUTHN,
        signerAssert: { flags: 0x01 },
      });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidSignerSignature");
    });

    it("rejects a signer assertion over a challenge other than the statement digest", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { digest } = await makeCosign(vestige, signerKey, cosignerKey);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        kind: WEBAUTHN,
        signerChallenge: cosignChallenge(digest, signerKey.pub),
      });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidSignerSignature");
    });

    it("rejects a passkey's signer assertion reused as its cosigner assertion", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const blockNumber = (await ethers.provider.getBlock("latest")).number;
      // X = signerKey signs a statement as a passkey signer; reuse that assertion to cosign Y's statement.
      const { signerAuth } = await makeCosign(vestige, signerKey, cosignerKey, { kind: WEBAUTHN, blockNumber });
      const { statement } = await makeCosign(vestige, generateKey(), cosignerKey, { blockNumber });
      await expect(vestige.cosign(statement, signerKey.pub, signerAuth)).to.be.revertedWithCustomError(
        vestige,
        "InvalidCosignerSignature",
      );
    });

    it("rejects a raw P-256 signature declared as WebAuthn", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      statement.kind = WEBAUTHN;
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "MalformedSignature");
    });

    it("rejects a WebAuthn assertion declared as raw P-256", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { kind: WEBAUTHN });
      statement.kind = P256;
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "MalformedSignature");
    });
  });

  describe("replay", function () {
    it("rejects resubmission of the same co-signature", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      await mine(1);
      const [cosignId] = await vestige.verify(statement, cosigner, auth);
      await vestige.cosign(statement, cosigner, auth);
      await expect(vestige.cosign(statement, cosigner, auth))
        .to.be.revertedWithCustomError(vestige, "AlreadyRecorded")
        .withArgs(cosignId);
    });

    it("rejects fresh signatures over an already-recorded statement and key pair", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const blockNumber = (await ethers.provider.getBlock("latest")).number;
      const first = await makeCosign(vestige, signerKey, cosignerKey, { blockNumber });
      const second = await makeCosign(vestige, signerKey, cosignerKey, { blockNumber, assert: { counter: 2 } });
      expect(second.statement.signature).to.not.equal(first.statement.signature);
      await vestige.cosign(first.statement, first.cosigner, first.auth);
      await expect(vestige.cosign(second.statement, second.cosigner, second.auth)).to.be.revertedWithCustomError(
        vestige,
        "AlreadyRecorded",
      );
    });

    it("rejects a statement signed for another deployment", async function () {
      const { Vestige, vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const other = await Vestige.deploy();
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { target: other });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidSignerSignature");
    });
  });

  describe("block anchor", function () {
    it("accepts an anchor exactly maxAge blocks old", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      await mine(MAX_AGE - 1); // the cosign tx lands in the next block: age == MAX_AGE
      await expect(vestige.cosign(statement, cosigner, auth)).to.emit(vestige, "Cosigned");
    });

    it("rejects an anchor older than maxAge", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      await mine(MAX_AGE);
      await expect(vestige.cosign(statement, cosigner, auth))
        .to.be.revertedWithCustomError(vestige, "StaleBlock")
        .withArgs(statement.blockNumber);
    });

    it("rejects an anchor that is not yet in the past", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const blockNumber = (await ethers.provider.getBlock("latest")).number + 1;
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        blockNumber,
        blockHash: ethers.hexlify(ethers.randomBytes(32)),
      });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "StaleBlock");
    });

    it("rejects an anchor older than 256 blocks when the window allows it but history cannot serve it", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { maxAge: 1000 });
      await mine(300);
      await expect(vestige.cosign(statement, cosigner, auth))
        .to.be.revertedWithCustomError(vestige, "BlockHashUnavailable")
        .withArgs(statement.blockNumber);
    });

    it("accepts an anchor older than 256 blocks via the EIP-2935 history contract", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { maxAge: 1000 });
      await mine(300);
      await recordHistory(statement.blockNumber);
      await expect(vestige.cosign(statement, cosigner, auth)).to.emit(vestige, "Cosigned");
    });

    it("accepts an anchor exactly maxAge blocks old at the 8191 limit", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { maxAge: 8191 });
      await mine(8190);
      await recordHistory(statement.blockNumber);
      await expect(vestige.cosign(statement, cosigner, auth)).to.emit(vestige, "Cosigned");
    });

    it("rejects a block hash that does not match the history contract", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        maxAge: 1000,
        blockHash: ethers.hexlify(ethers.randomBytes(32)),
      });
      await mine(300);
      await recordHistory(statement.blockNumber);
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "BlockHashMismatch");
    });

    it("rejects a block hash that does not match the chain", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        blockHash: ethers.hexlify(ethers.randomBytes(32)),
      });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "BlockHashMismatch");
    });
  });

  describe("cosigner signature", function () {
    it("rejects an assertion over a challenge for a different signer key", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { digest } = await makeCosign(vestige, signerKey, cosignerKey);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        challenge: cosignChallenge(digest, generateKey().pub),
      });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidCosignerSignature");
    });

    it("rejects an assertion submitted under a different cosigner key", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, auth } = await makeCosign(vestige, signerKey, cosignerKey);
      await expect(vestige.cosign(statement, generateKey().pub, auth)).to.be.revertedWithCustomError(
        vestige,
        "InvalidCosignerSignature",
      );
    });

    it("rejects a non-assertion clientDataJSON type", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, {
        assert: { type: "webauthn.create" },
      });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidCosignerSignature");
    });

    it("requires user verification", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { assert: { flags: 0x01 } });
      await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidCosignerSignature");
    });
  });

  describe("signer's window", function () {
    it("rejects a window outside 1..8191", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      for (const maxAge of [0, 8192]) {
        const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { maxAge });
        await expect(vestige.cosign(statement, cosigner, auth))
          .to.be.revertedWithCustomError(vestige, "InvalidMaxAge")
          .withArgs(maxAge);
      }
    });

    it("enforces a short window the signer declared", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      const ok = await makeCosign(vestige, signerKey, cosignerKey, { maxAge: 3 });
      await mine(2); // lands at age 3
      await expect(vestige.cosign(ok.statement, ok.cosigner, ok.auth)).to.emit(vestige, "Cosigned");

      const late = await makeCosign(vestige, signerKey, generateKey(), { maxAge: 3 });
      await mine(3); // lands at age 4
      await expect(vestige.cosign(late.statement, late.cosigner, late.auth)).to.be.revertedWithCustomError(vestige, "StaleBlock");
    });

    for (const [mode, kind] of [["raw P-256", P256], ["passkey", WEBAUTHN]]) {
      it(`rejects a window stretched after a ${mode} signer signed`, async function () {
        const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
        const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { kind, maxAge: 3 });
        await mine(5);
        statement.maxAge = 1000;
        await expect(vestige.cosign(statement, cosigner, auth)).to.be.revertedWithCustomError(vestige, "InvalidSignerSignature");
      });
    }

    it("rejects anchors older than 256 blocks on a chain without EIP-2935", async function () {
      const { vestige, signerKey, cosignerKey } = await loadFixture(deploy);
      await setCode(HISTORY_STORAGE, "0x");
      const { statement, cosigner, auth } = await makeCosign(vestige, signerKey, cosignerKey, { maxAge: 1000 });
      await mine(300);
      await expect(vestige.cosign(statement, cosigner, auth))
        .to.be.revertedWithCustomError(vestige, "BlockHashUnavailable")
        .withArgs(statement.blockNumber);
    });
  });

  describe("deployment", function () {
    it("takes no constructor arguments and always requires user verification", async function () {
      const { Vestige } = await loadFixture(deploy);
      expect(Vestige.interface.deploy.inputs).to.have.length(0);
      expect(await (await Vestige.deploy()).REQUIRE_USER_VERIFICATION()).to.equal(true);
    });
  });
});
