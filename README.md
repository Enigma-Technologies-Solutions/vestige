# Vestige

On-chain verification that two P-256 keys co-signed a recent block hash. Successor to
[onchecked](https://github.com/0xjjpa/onchecked) (secp256k1 wallets, `PoE.sol`) and
[troye](https://github.com/0xjjpa/troye) (WebCrypto checkpoint + passkey, off-chain checks).

## Primitive

```
M         = abi.encode(STATEMENT_TAG, chainId, vestige, n, blockhash(n), maxAge)
digest    = sha256(M)
signer    signs digest              (raw P-256, or a WebAuthn assertion whose challenge is digest)
cosigner  signs keccak256(abi.encode(COSIGN_TAG, digest, signerKey))   (WebAuthn assertion)
Vestige.cosign(...)  checks the window, the hash of block n, both signatures, then records + emits Cosigned
```

A `Cosigned` event proves the cosigner acted **after** block `n` existed (block hashes are unpredictable),
**before** the inclusion block, **within the window the signer declared**, and **over this signer's statement**. Proximity comes from the transport
(the cosigner scans the signer's QR, NFC tag, BLE advert…); it is not proven cryptographically.

### Modes (product framing; the contract only knows signature formats)

| Mode | Signer (A) | `SignatureKind` | Cosigner (B) |
|---|---|---|---|
| **Beacon** | Unattended device key (kiosk, door reader, IoT) re-signing every block | `P256` | Passkey |
| **Handshake** | A person's passkey, one tap; B then has the declared window | `WebAuthn` | Another passkey |

## Contract: `contracts/Vestige.sol`

`cosign(Statement statement, PublicKey cosigner, WebAuthn.WebAuthnAuth auth)` where
`Statement { PublicKey signer; SignatureKind kind; uint256 blockNumber; bytes32 blockHash; uint256 maxAge; bytes signature; }`.
The contract has no constructor arguments, no immutables and no admin, so one build deploys to the same CREATE2 address
on every chain. User verification is always required (`REQUIRE_USER_VERIFICATION = true`).
`signature` is `r ‖ s` (64 bytes) for `P256`, or the flat ABI encoding of a `WebAuthnAuth`
(`abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON)`) for `WebAuthn`.

| Check | Failure |
|---|---|
| signer's window `1 <= maxAge <= 8191` | `InvalidMaxAge` |
| `n < block.number` and `block.number - n <= maxAge` | `StaleBlock` |
| hash of block `n` is available: `blockhash` within 256 blocks, EIP-2935 history contract beyond | `BlockHashUnavailable` |
| that hash `== blockHash` | `BlockHashMismatch` |
| signer key ≠ cosigner key | `SelfCosign` |
| signature decodes for its declared kind | `MalformedSignature` |
| signer's P-256 signature over `digest`, or WebAuthn assertion with challenge `digest` | `InvalidSignerSignature` |
| cosigner's WebAuthn assertion over the cosign challenge (type, challenge, UP, UV, BE/BS) | `InvalidCosignerSignature` |
| `cosignId = keccak256(digest, signerKey, cosignerKey)` not yet recorded | `AlreadyRecorded` |

- `verify()` is a view with the same checks and no state change; `cosign()` records. Anyone may submit. Both
  return `(cosignId, age)`, where `age = block.number - n`.
- `Cosigned(cosignId, signerKey, cosignerKey, signerKind, blockNumber, blockHash, maxAge, age)`: the kind tells a
  reader which mode produced it.
- **The window belongs to the signer.** `maxAge` is inside `M`, and the cosigner's challenge commits to `digest`.
  Neither the relayer nor the cosigner can widen it: a changed `maxAge` fails `InvalidSignerSignature`. A door
  beacon might declare 10 blocks and a conference handshake an hour; declaring 8191 means "as long as the chain
  can check". Readers, or contracts calling `verify()`, may apply a tighter limit using `age`.
- The signer's challenge (`digest`) and the cosigner's (`keccak256(COSIGN_TAG, …)`) always differ, so a
  passkey's assertion as signer can never be replayed as a cosigner assertion or vice versa.
- Uses OpenZeppelin `P256` and `WebAuthn`: native precompile (EIP-7951 on L1, RIP-7212 on L2s) when present,
  pure-Solidity fallback otherwise.
- `M` binds chain id and contract address, so a statement is not valid on another deployment.
- Anchors more than 256 blocks old (the `blockhash` limit) are read from the EIP-2935 history contract
  (`0x0000F90827F1C53a10cb7A02335B175320002935`). On a chain without it they fail `BlockHashUnavailable`.
  8191 blocks is about 27 h on Ethereum, 4.5 h on a 2 s L2 and 41 min on Monad.

## Client requirements

- **Low-s signatures.** WebCrypto and authenticators emit random `s`; submit `s' = n - s` when `s > n/2`.
  The cosigner binds the statement *digest and signer key*, not the signer's signature bytes, so this
  normalization never invalidates the co-signature.
- **P-256 signer.** `crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, key, M)` where `M` is the
  `statementMessage(n, hash, maxAge)` bytes (computable client-side; see `test/Vestige.test.js`).
- **Passkey signer / cosigner.** `navigator.credentials.get({publicKey: {challenge: <32 bytes>, ...}})`; submit
  `authenticatorData`, `clientDataJSON`, and the indices of `"challenge":"` and `"type":"` in it.
- **Pre-checking with `eth_call`.** `eth_call` runs at the head block, so `verify()` rejects an anchor equal to
  the head. Anchor at least one block behind head (also wiser for reorgs).

## Chain requirements

A chain qualifies only if all of these hold. They were probed live; the script is not part of this repo.

- **P-256 precompile** at `0x100` (EIP-7951 / RIP-7212). The Solidity fallback works but costs about 6× the gas.
- **Honest `blockhash`**: the EVM returns the real hash of block `n`. Arbitrum fails this: it returns pseudo-random
  hashes, and `block.number` there tracks L1.
- **Unpredictable block hashes**: either the header carries randomness (`prevrandao`) or blocks are full of other
  parties' transactions. On-demand chains whose blocks hold about one transaction are weak here.
- **EVM-equivalent CREATE2**, so one address works everywhere. zkSync Era fails this.
- **EIP-2935** for windows above 256 blocks (Monad, Base and Ethereum all have it).

## Deploy: same address on every chain

```bash
npm run deploy:build     # bundles WalletConnect into web/vendor/wallet.js, writes web/deploy-bundle.json
npm run serve            # then open http://localhost:8080/deploy.html
```

`deploy.html` sends `salt ‖ initcode` to Arachnid's CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`)
with salt `0x00…00`, so Vestige lands at `keccak256(0xff ‖ factory ‖ salt ‖ keccak256(initcode))` on every chain.
The address commits to the bytecode: anyone can repeat the deployment on a new chain, and it can only ever
place this exact code there.

- **Wallet:** WalletConnect (prefilled with this project's Reown project id; another id can be pasted and is kept in
  the browser; the page draws its own QR), a browser extension wallet, or for testnets a **test wallet**: a throwaway
  key generated in the browser and kept unencrypted in its localStorage. You fund its address yourself; it refuses to
  switch to or sign on mainnets, and *Copy private key* recovers leftover testnet funds. The wallet only signs; the page reads every chain over its public RPC.
- **Checks per chain, before deploy:** RPC chain id, P-256 precompile, honest `blockhash`, EIP-2935 (advisory),
  factory code hash, and a dry run proving the factory's CREATE2 address derivation.
- **Gates:** on mainnets the connected account must match the expected deployer (default `jjpa.eth`, resolved on
  Ethereum); testnets take any account, since the address never depends on the deployer;
  the address must be empty, gas is estimated against the balance, and mainnets ask for confirmation.
- **Confirmation:** success means the code at the address equals the build's runtime code. It polls the code, not
  the receipt, so it also works when the deployer is a smart account and the hash is not a transaction.
- **Record:** *Download deployments.json* gives the address, build hashes, and tx per chain.
- **Rehearsal:** `npm run deploy:local-factory` installs the factory on the local node; then open
  `deploy.html?local=1`, which adds Hardhat local as a network.

Open it at `http://localhost`, not `file://`: Chrome blocks `fetch` from `file://` pages, and WalletConnect needs a
real origin.

### Verify the source on explorers

```bash
npm run verify:key                         # checks API_ETHERSCAN_KEY (.env) on all six chains; never prints it
npm run verify -- --network sepolia        # sepolia | baseSepolia | monadTestnet | mainnet | base | monad
```

`scripts/verify.js` first checks that the code at the CREATE2 address equals this build (it refuses if the contract
was recompiled since), then submits the source to Sourcify (no key) and to Etherscan's V2 API (one key for every
chain, including monadscan.com), each independently. Results go to `verification.json`, keyed by chain id. The
networks in `hardhat.config.js` are read-only public RPCs with no accounts: deploying stays in the browser wallet.
Do not change `Vestige.sol`, its imports or compiler settings between chains: any change moves the address.

## Not checked on-chain

Origin and RP ID hash (enforced by the authenticator, which scopes the passkey to its RP), signature counter,
attestation, and who owns a key. Vestige proves *these two keys co-signed in this window*; mapping keys to
stores, people, or rewards is an application concern.

## Run

```bash
npm install
npm test                 # native P-256 (Osaka default)  ~84k gas (Beacon) / ~96k (Handshake) per cosign
npm run test:fallback    # Solidity P-256 fallback        ~563k / ~574k
```

## Lab: real passkeys against a local node

```bash
npm run node             # terminal 1: Hardhat node on 127.0.0.1:8545
npm run deploy           # terminal 2: deploys, writes web/deployment.json, mines a block every 2s
npm run serve            # terminal 2: http://localhost:8080
```

Open **http://localhost:8080** (use `localhost`, not `127.0.0.1`: the passkey RP ID is the hostname).

1. **Mode** — *Beacon*: A is a non-extractable WebCrypto P-256 key in IndexedDB that signs the statement for
   block `head − 1` on every block. *Handshake*: A is one of your passkeys; *Sign as A* taps once.
2. **Passkeys** — enroll one for Beacon, two for Handshake (Touch ID twice, a security key, or a phone via the
   browser's QR/hybrid flow). A and B must be different passkeys.
3. **Co-sign as B** — the passkey signs the cosign challenge and the page pre-checks with `verify()`.
4. **Submit** — `cosign()` is sent from the node's unlocked account 0 acting as relayer.
5. **Attacks** — replay, stale anchor, forged block hash, stretched window, wrong signer key, wrong cosigner
   key, self co-sign; each is rejected with the contract's custom error.
6. **Public record** — `Cosigned` events are read back from the chain, with the mode, age and window of each.
7. **Session log** — *Download session log* exports JSON of what only the browser sees: WebAuthn requests,
   results and errors (`NotAllowedError` etc.), `clientDataJSON`, authenticator flags and sign count, evidence,
   status messages and decoded reverts. Every entry carries the head block; submissions carry tx hashes, so it
   lines up with the `npm run node` output. It holds public data only, persists across reloads (last 1000
   entries) and has a *Clear* button.

8. **Source** — every file compiled into the contract (Vestige.sol plus the OpenZeppelin imports), with four
   checks against the code at the deployed address: runtime bytecode equals the compiler output exactly, the
   contract has no constructor arguments or immutables, the metadata IPFS hash embedded in the bytecode matches
   this build, and each file's keccak256 matches the metadata. `npm run deploy` writes the
   bundle (`web/contract-source.json`); for an existing deployment run `npx hardhat run scripts/export-source.js`.
   This ties the deployed code to these files' fingerprint; proving the compiler produced it needs a recompile.

**Public testnets.** The network picker in the nav (or `?net=baseSepolia`, `monadTestnet`, `sepolia`) runs the same lab
against the CREATE2 deployment there, over the public RPC. `cosign()` is paid by the relayer in `npm run serve`
(`scripts/relay.js`) when `.env` has `LAB_RELAYER_KEY` (or `SEPOLIA_ETH_KEY`): the key stays in the server, which only
sends `cosign()` to Vestige on these testnets and only for requests from the lab's own origin. Without it, the deploy
page's test wallet pays (same origin). Attacks and `verify()` are simulated and cost nothing.
Defaults change with the chain: A anchors 2 blocks behind head (load-balanced RPCs), the window defaults to about two
minutes (600 blocks on Base Sepolia at 0.2 s, 400 on Monad at 0.3 s, 10 on Sepolia) and goes up to 8191, so anchors
older than 256 blocks exercise EIP-2935 for real. *Stale* waits out the window instead of mining, and the public
record shows only the last few thousand blocks, since these RPCs return 100–5000 blocks of logs per request.

The **Window** field on A sets the `maxAge` A signs (1–256 in the lab; stored per browser). Attacks are refused in
the page when the evidence is older than its window: the contract checks the anchor's age
first, so they would only ever report `StaleBlock`. Co-sign again to get fresh evidence.

The page uses the ETS brand as on sanctum.enigma.sh (ink/volt tokens, Poppins · Inter · Space Mono self-hosted
under SIL OFL-1.1 in `web/assets/fonts/`), light by default with a dark theme, and a strict CSP: scripts and
styles load only from the page's origin (`web/app.js`, `web/theme.js`, `web/styles.css`).

Hardhat 2 only stubs the EIP-2935 contract (NomicFoundation/hardhat#6226): the tests install mainnet's bytecode and
write the history slots themselves. On the local node, anchors older than 256 blocks would revert
`BlockHashUnavailable`, which is why the lab caps the window at 256.

Deploy option: `VESTIGE_BLOCK_INTERVAL_MS` (default 2000).
Restarting the node wipes the chain: redeploy and reload. Passkeys enrolled for `localhost` stay in your
authenticator; *Forget* only removes them from the page.
