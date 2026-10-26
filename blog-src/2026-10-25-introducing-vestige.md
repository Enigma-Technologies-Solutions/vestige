---
title: "Introducing Vestige"
date: "2026-10-25"
slug: "introducing-vestige"
excerpt: "Vestige is proof of interaction: a small contract that records, on-chain, that two P-256 keys co-signed a recent block. Passkeys and device keys can now leave a public, checkable trace of an encounter."
---

A lot of useful claims have the same shape: these two parties met, and it happened around this time. A visitor badged in at a door. A courier handed a parcel to a recipient. Two people at a conference exchanged contacts. Today that record usually lives in one company's database, and checking it means trusting whoever runs it.

Vestige is proof of interaction: it makes that kind of record public and checkable without trusting anyone in particular. It is a single contract, `Vestige.sol`, that verifies two signatures over a recent block and records the result as an event anyone can read. It is live and source-verified on Ethereum, Base and Monad, at the same address on each: `0xc5b8A9e7175c102d51116249F121A65079224b6f`.

## How it works

The idea rests on a property every blockchain already has: a block's hash cannot be predicted before the block exists. If you sign something that includes that hash, you have proven you signed it *after* the block was produced. If your signature is then included in a later block, it existed *before* that one. Together, the two blocks bracket the moment.

Vestige applies this to two keys:

1. **The signer (A)** signs a statement containing a recent block number, that block's hash, and a window: how many blocks the other party has to respond.
2. **The cosigner (B)** signs over A's statement and A's key, using a passkey.
3. **The contract** checks that the block hash is real, that the window has not passed, and that both signatures are valid, then records the pair and emits a `Cosigned` event.

The window belongs to the signer. It sits inside what A signs, so neither B nor whoever submits the transaction can stretch it. A door reader might allow ten blocks; a conference handshake might allow an hour.

Anyone can submit the transaction, so neither party needs a funded wallet. A relayer can pay the gas without being able to change what was signed.

## Why P-256

On-chain signatures mostly use secp256k1, the curve behind Ethereum wallets. The keys people actually carry, passkeys on phones and laptops and the secure hardware in door readers and embedded devices, use P-256.

Vestige verifies P-256 directly, including WebAuthn assertions from passkeys, using OpenZeppelin's implementation. On chains with the P-256 precompile (EIP-7951 on Ethereum, RIP-7212 on L2s), a co-signature costs between roughly 84,000 and 100,000 gas. On chains without it, a pure Solidity fallback still works at several times the cost. Nobody has to install a wallet to take part; a fingerprint or a face scan is enough.

## Two ways to use it

**Beacon.** A is an unattended device, such as a kiosk, a door reader, or a sensor, that re-signs the latest block every time a new one arrives. A person walks up, scans its QR code or taps its NFC tag, and co-signs with their passkey.

**Handshake.** A is a person whose passkey signs once. B, another person, then has the window A declared to co-sign.

The contract does not know which mode is in use. It sees a signer, a window and a cosigner.

## Use it

Here is the Beacon flow end to end in a browser, with ethers v6. The device key is a WebCrypto P-256 key; B is a passkey enrolled earlier, whose public key you kept as `{ x, y }`.

### 1. A signs a recent block

Anchor a couple of blocks behind the head, so the RPC node you talk to certainly has the block, and so `verify()` (which runs at the head) accepts it. The contract builds the exact bytes A signs, bound to this chain and this deployment:

```js
const vestige = new ethers.Contract("0xc5b8A9e7175c102d51116249F121A65079224b6f", abi, provider);
const block = await provider.getBlock((await provider.getBlockNumber()) - 2);
const maxAge = 600; // A's window, in blocks

const message = await vestige.statementMessage(block.number, block.hash, maxAge);
const raw = new Uint8Array(await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" }, deviceKey.privateKey, ethers.getBytes(message)));

const statement = {
  signer: devicePublicKey,            // { x, y }, 32 bytes each
  kind: 0,                            // SignatureKind.P256
  blockNumber: block.number, blockHash: block.hash, maxAge,
  signature: lowS(raw),               // r ‖ s, with s normalized (below)
};
```

The contract only accepts low-s signatures, and WebCrypto and authenticators produce either half at random. Normalizing is one subtraction:

```js
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
function lowS(rs) {
  let s = BigInt(ethers.hexlify(rs.slice(32)));
  if (s > N / 2n) s = N - s;
  return ethers.concat([rs.slice(0, 32), ethers.toBeHex(s, 32)]);
}
```

The device puts `statement` in a QR code or an NFC tag. That transport is what makes the encounter physical.

### 2. B co-signs with a passkey

B's challenge commits to A's statement digest and A's key, never to A's signature bytes, so normalizing A's `s` can never break it:

```js
const digest = await vestige.statementDigest(block.number, block.hash, maxAge);
const challenge = await vestige.cosignChallenge(digest, statement.signer);

const a = await navigator.credentials.get({ publicKey: {
  challenge: ethers.getBytes(challenge),
  allowCredentials: [{ type: "public-key", id: passkeyId }],
  userVerification: "required",
} });
```

The assertion becomes a `WebAuthnAuth`. Its signature arrives DER-encoded, so unwrap it to `r ‖ s` and normalize `s` as before. The two indices are byte offsets into `clientDataJSON`, which the contract uses to find the challenge and type without parsing JSON:

```js
const clientData = new Uint8Array(a.response.clientDataJSON);
const rs = lowS(derToRaw(new Uint8Array(a.response.signature)));
const auth = {
  r: ethers.dataSlice(rs, 0, 32), s: ethers.dataSlice(rs, 32),
  challengeIndex: byteIndexOf(clientData, '"challenge":"'),
  typeIndex: byteIndexOf(clientData, '"type":"'),
  authenticatorData: ethers.hexlify(new Uint8Array(a.response.authenticatorData)),
  clientDataJSON: new TextDecoder().decode(clientData),
};
```

`derToRaw` and `byteIndexOf` are a dozen lines each; [the lab's source](/lab/app.js) has both.

### 3. Check, then record

`verify()` runs every check as a free `eth_call` and reverts with a named error when one fails: `StaleBlock`, `BlockHashMismatch`, `InvalidCosignerSignature` and so on. `cosign()` runs the same checks and records the result. Anyone can send it:

```js
const [cosignId, age] = await vestige.verify(statement, cosigner, auth);
const tx = await vestige.connect(relayer).cosign(statement, cosigner, auth);
```

### 4. Read the record, or gate on it

Each recorded co-signature is a `Cosigned` event, with both key ids indexed. A key id is `keccak256(abi.encode(x, y))`, which the contract also exposes as `keyId()`. To list every encounter a passkey co-signed:

```js
const logs = await vestige.queryFilter(vestige.filters.Cosigned(null, null, cosignerKeyId), fromBlock);
```

A contract can gate on a co-signature instead, and demand more than A did. `verify()` returns how many blocks old the anchor is, so a venue can insist on its own device and a ten-block window:

```solidity
(bytes32 cosignId, uint256 age) = vestige.verify(statement, cosigner, auth);
require(vestige.keyId(statement.signer) == venueKey);
require(age <= 10, "too old");
```

In Handshake mode, A signs with a passkey too: the WebAuthn challenge is `statementDigest(...)` itself, `kind` is `1`, and `signature` is the ABI encoding of A's `WebAuthnAuth`.

## What it does not prove

Vestige proves that these two keys co-signed within this window. It does not prove the two parties were physically together; that comes from how B received A's statement, whether a QR code on a wall or an NFC tap, and the transport is outside the contract. It also does not say who owns a key. Mapping keys to people, stores or rewards is the application's job.

The chain matters too. Vestige needs an honest `blockhash`, so it is not deployed on chains like Arbitrum, where the EVM returns pseudo-random hashes.

## Who it is for

Vestige is for developers building check-ins, proof of attendance, custody handovers or device attestations who want the record to outlive their own servers. The contract has no owner, no admin and no constructor arguments. It was deployed through a CREATE2 factory with a fixed salt, so the address commits to the bytecode: anyone can deploy it to a new chain, and only this exact code can land at that address.

It is live and verified on Ethereum, Base and Monad, and on Sepolia, Base Sepolia and Monad testnet for experiments. [The lab](/lab/) runs the whole ceremony in your browser: enroll a passkey, co-sign a block on a testnet, and try the attacks the contract rejects. If you are building something that needs this primitive, we would like to hear about it.
