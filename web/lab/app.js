'use strict';
const PARAMS = new URLSearchParams(location.search);
// Where the lab runs. Remote networks use the CREATE2 deployment (same address everywhere) and the deploy page's
// test wallet as relayer. anchorLag: how far behind head A anchors, so load-balanced RPC nodes have the block too.
// logRange: the most blocks the RPC returns logs for in one request. lookback: how far back the record is read.
const NETWORKS = {
  local: { name: 'Hardhat local', rpc: PARAMS.get('rpc') || 'http://127.0.0.1:8545', local: true, anchorLag: 1, logRange: 10000, windowDefault: 32 },
  baseSepolia: { name: 'Base Sepolia', chainId: 84532, rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
    deployBlock: 49752675, blockSeconds: 0.2, anchorLag: 2, logRange: 200, lookback: 3000, windowDefault: 600 },
  monadTestnet: { name: 'Monad testnet', chainId: 10143, rpc: 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadscan.com',
    deployBlock: 73902933, blockSeconds: 0.3, anchorLag: 2, logRange: 100, lookback: 3000, windowDefault: 400 },
  sepolia: { name: 'Sepolia', chainId: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io',
    deployBlock: 11985892, blockSeconds: 12, anchorLag: 2, logRange: 5000, lookback: 20000, windowDefault: 10 },
};
// Served from localhost the lab defaults to the local node; hosted, the local node is not offered at all.
const ON_LOCALHOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (!ON_LOCALHOST) delete NETWORKS.local;
const NET_KEY = Object.hasOwn(NETWORKS, PARAMS.get('net') ?? '') ? PARAMS.get('net') : ON_LOCALHOST ? 'local' : 'baseSepolia';
const NET = NETWORKS[NET_KEY];
const RPC = NET.rpc;
// Who pays for cosign() on remote networks: the local server's relayer (key in .env, see scripts/relay.js) if it has
// one, else the deploy page's test wallet (same origin), else the visitor's own browser wallet (the hosted lab).
const TEST_WALLET = 'vestige-deploy-test-wallet-key';
let serverRelay = null, browserPayer = false;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const PASSKEYS = 'vestige-lab-passkeys-v1', LEGACY_PASSKEYS = 'vestige-lab-witnesses-v1', MODE = 'vestige-lab-mode';
const WINDOW = 'vestige-lab-window' + (NET.local ? '' : '-' + NET_KEY);
// The contract accepts windows up to 8191 blocks (EIP-2935); Hardhat's history contract is a stub, so locally the lab
// stops at 256. Defaults are about two minutes on remote chains, whose blocks come every 0.2 s to 12 s.
const WINDOW_MAX = NET.local ? 256 : 8191, WINDOW_DEFAULT = NET.windowDefault;
const KIND = { P256: 0, WEBAUTHN: 1 }; // Vestige.SignatureKind
const KIND_MODE = ['Beacon', 'Handshake'];
const $ = id => document.getElementById(id);
const dec = new TextDecoder(), enc = new TextEncoder();
const coder = ethers.AbiCoder.defaultAbiCoder();
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const word = v => '0x' + v.toString(16).padStart(64, '0');
const short = h => h ? h.slice(0, 10) + '…' + h.slice(-6) : '—';
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));

// `current` is A's signed statement; `evidence` adds B's co-signature and is what the contract receives.
let D, provider, vestige, beacon, stranger, current = null, evidence = null, lastAccepted = null;
let head = 0, busy = false, ticking = false, online = null;
let mode = (() => { try { return localStorage.getItem(MODE) === 'handshake' ? 'handshake' : 'beacon'; } catch { return 'beacon'; } })();
const rejected = [];
const windowBlocks = () => {
  const n = Math.round(Number($('window').value));
  return Number.isFinite(n) ? Math.min(WINDOW_MAX, Math.max(1, n)) : WINDOW_DEFAULT;
};
$('window').max = String(WINDOW_MAX);
$('window').value = String(WINDOW_DEFAULT);
try { $('window').value = String(Number(localStorage.getItem(WINDOW)) || WINDOW_DEFAULT); } catch {}
// Rough wall-clock length of `blocks`, for windows on fast chains.
const blockSeconds = () => NET.blockSeconds ?? (D?.blockIntervalMs ?? 0) / 1000;
const duration = blocks => {
  const s = blocks * blockSeconds();
  return !s ? '' : s < 90 ? `≈ ${Math.round(s)} s` : s < 5400 ? `≈ ${Math.round(s / 60)} min` : `≈ ${(s / 3600).toFixed(1)} h`;
};
// A transaction hash as a link to the network's explorer in a new tab; plain text where there is none (local node).
function txLink(hash, text = short(hash)) {
  if (!NET.explorer) return document.createTextNode(text);
  const a = document.createElement('a');
  a.className = 'link'; a.href = `${NET.explorer}/tx/${hash}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = text; a.title = `Open ${hash} on ${new URL(NET.explorer).host}`;
  return a;
}
const blocksText = b => [`${b} blocks`, duration(b)].filter(Boolean).join(' ');
// The block A signs: a little behind head (see anchorLag).
const anchorBlock = async h => provider.getBlock((h ?? await freshHead()) - NET.anchorLag);

// ---- session journal: what only the browser sees (WebAuthn ceremonies, evidence, decoded errors) ----
// Persisted so a log survives a reload; downloaded as JSON for comparison with the node's own log.
const JOURNAL = 'vestige-lab-journal-v1', JOURNAL_MAX = 1000;
const session = crypto.randomUUID();
let journal = (() => { try { return JSON.parse(localStorage.getItem(JOURNAL)) || []; } catch { return []; } })();
const toJSON = (k, v) => typeof v === 'bigint' ? v.toString() : v;

function record(type, data = {}) {
  journal.push(JSON.parse(JSON.stringify({ at: new Date().toISOString(), session, head: head || null, mode, type, ...data }, toJSON)));
  if (journal.length > JOURNAL_MAX) journal = journal.slice(-JOURNAL_MAX);
  try { localStorage.setItem(JOURNAL, JSON.stringify(journal)); } catch {}
  renderLogInfo();
}
function renderLogInfo() { $('logInfo').textContent = `${journal.length} event${journal.length === 1 ? '' : 's'} recorded`; }
renderLogInfo();

const hexOf = buf => ethers.hexlify(new Uint8Array(buf));
const errInfo = e => ({ name: e?.name, message: e?.message, code: e?.code, reason: reason(e), revertData: revertData(e) });

function parseAuthData(hex) {
  const b = ethers.getBytes(hex), f = b[32];
  return {
    rpIdHashMatches: ethers.hexlify(b.slice(0, 32)) === ethers.sha256(enc.encode(location.hostname)),
    flags: { UP: !!(f & 1), UV: !!(f & 4), BE: !!(f & 8), BS: !!(f & 16), AT: !!(f & 64), ED: !!(f & 128) },
    signCount: new DataView(b.buffer, b.byteOffset).getUint32(33),
    length: b.length,
  };
}

// ---- encodings (mirror Vestige.sol) ----
const statementMessage = (n, hash, maxAge) => coder.encode(
  ['bytes32', 'uint256', 'address', 'uint256', 'bytes32', 'uint256'],
  [ethers.id('vestige.statement.v2'), D.chainId, D.address, n, hash, maxAge]);
const cosignChallenge = (digest, key) => ethers.keccak256(coder.encode(
  ['bytes32', 'bytes32', 'bytes32', 'bytes32'], [ethers.id('vestige.cosign.v1'), digest, key.x, key.y]));
const keyId = key => ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [key.x, key.y]));
// Flat ABI encoding of WebAuthn.WebAuthnAuth, as the contract's WebAuthn.tryDecodeAuth expects.
const encodeAuth = a => coder.encode(
  ['bytes32', 'bytes32', 'uint256', 'uint256', 'bytes', 'string'],
  [a.r, a.s, a.challengeIndex, a.typeIndex, a.authenticatorData, a.clientDataJSON]);
const args = e => [e.statement, e.cosigner, e.auth];

// P256.verify only accepts s <= n/2; WebCrypto and authenticators produce either half.
function lowS(raw) {
  const r = BigInt(ethers.hexlify(raw.slice(0, 32)));
  let s = BigInt(ethers.hexlify(raw.slice(32)));
  if (s > N / 2n) s = N - s;
  return { r: word(r), s: word(s) };
}

function rawDER(a) {
  let i = 0;
  const len = () => { let n = a[i++]; if (n & 128) { let k = n & 127; n = 0; while (k--) n = n * 256 + a[i++]; } return n; };
  check(a[i++] === 0x30, 'Invalid DER sequence');
  check(len() === a.length - i, 'Invalid DER length');
  const out = new Uint8Array(64);
  for (let k = 0; k < 2; k++) {
    check(a[i++] === 0x02, 'Invalid DER integer');
    const n = len(); let v = a.slice(i, i + n); i += n;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    check(v.length <= 32, 'Oversized DER integer');
    out.set(v, 32 * k + 32 - v.length);
  }
  check(i === a.length, 'Trailing DER data');
  return out;
}

// Index of `needle` in the UTF-8 bytes of clientDataJSON; the contract indexes bytes, not UTF-16 units.
function byteIndexOf(bytes, needle) {
  const n = enc.encode(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return i;
  }
  throw new Error('clientDataJSON is missing ' + needle);
}

// Reads the head straight from the node: ethers caches getBlockNumber(), which lags right after hardhat_mine.
const freshHead = async () => Number(await provider.send('eth_blockNumber', []));

// ---- beacon key: non-extractable, persisted as a CryptoKeyPair in IndexedDB ----
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('vestige-lab', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('keys', mode), req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function publicPoint(publicKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  return { x: ethers.hexlify(raw.slice(1, 33)), y: ethers.hexlify(raw.slice(33)) };
}

async function loadBeaconKey() {
  let pair = await idb('readonly', s => s.get('checkpoint'));
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await idb('readwrite', s => s.put(pair, 'checkpoint'));
  }
  return { pair, pub: await publicPoint(pair.publicKey) };
}

async function signBeacon(block) {
  const maxAge = windowBlocks();
  const message = ethers.getBytes(statementMessage(block.number, block.hash, maxAge));
  const { r, s } = lowS(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, beacon.pair.privateKey, message)));
  current = {
    statement: { signer: beacon.pub, kind: KIND.P256, blockNumber: block.number, blockHash: block.hash, maxAge, signature: ethers.concat([r, s]) },
    digest: ethers.sha256(message),
    signerLabel: 'Beacon',
  };
}

// ---- passkeys: only public data (credential id + P-256 point) is stored ----
function loadPasskeys() {
  try { return JSON.parse(localStorage.getItem(PASSKEYS) ?? localStorage.getItem(LEGACY_PASSKEYS)) || []; } catch { return []; }
}
function savePasskeys(list) { try { localStorage.setItem(PASSKEYS, JSON.stringify(list)); } catch {} }
const passkeyIn = id => loadPasskeys().find(p => p.id === $(id).value);
const labelOf = key => {
  const id = keyId(key);
  if (beacon && id === keyId(beacon.pub)) return 'This beacon';
  return loadPasskeys().find(p => keyId(p) === id)?.label;
};

async function enroll() {
  check(navigator.credentials, 'WebAuthn unavailable in this browser');
  const label = $('label').value.trim() || 'Passkey';
  const selection = { residentKey: 'preferred', userVerification: 'required' };
  if ($('attachment').value !== 'any') selection.authenticatorAttachment = $('attachment').value;
  status('Complete the passkey enrollment prompt…', 'warn', 'Passkey');
  record('webauthn.create.request', { label, rpId: location.hostname, authenticatorSelection: selection });
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Vestige Lab', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label + '-' + Date.now().toString(36), displayName: label },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: selection, attestation: 'none', timeout: 60000,
    } });
  } catch (e) {
    record('webauthn.create.error', errInfo(e));
    throw e;
  }
  check(cred, 'Enrollment cancelled');
  const authenticatorData = hexOf(cred.response.getAuthenticatorData());
  record('webauthn.create.result', {
    credentialId: cred.id,
    authenticatorAttachment: cred.authenticatorAttachment,
    transports: cred.response.getTransports?.(),
    algorithm: cred.response.getPublicKeyAlgorithm(),
    publicKeySpki: cred.response.getPublicKey() && hexOf(cred.response.getPublicKey()),
    clientDataJSON: dec.decode(cred.response.clientDataJSON),
    authenticatorData, authData: parseAuthData(authenticatorData),
    clientExtensionResults: cred.getClientExtensionResults(),
  });
  check(cred.response.getPublicKeyAlgorithm() === -7, 'Authenticator did not create an ES256 (P-256) key');
  const spki = new Uint8Array(cred.response.getPublicKey());
  check(spki.length === 91 && spki[26] === 0x04, 'Unexpected P-256 SubjectPublicKeyInfo encoding');
  const p = { id: cred.id, label, x: ethers.hexlify(spki.slice(27, 59)), y: ethers.hexlify(spki.slice(59)) };
  const list = [...loadPasskeys(), p];
  savePasskeys(list);
  $('label').value = `Passkey ${list.length + 1}`;
  renderPasskeys(p.id);
  const next = mode === 'handshake' && list.length < 2 ? ' Handshake needs one more: enroll a second passkey for B.' : '';
  status(`Enrolled “${label}” (key id ${short(keyId(p))}).${next}`, 'ok', 'Enrolled');
}

// Runs a WebAuthn assertion over `challenge` and returns it as a WebAuthn.WebAuthnAuth.
async function passkeyAssert(role, p, challenge) {
  const userVerification = 'required';
  record('webauthn.get.request', { role, passkey: { label: p.label, keyId: keyId(p), credentialId: p.id }, challenge, userVerification });
  let a;
  try {
    a = await navigator.credentials.get({ publicKey: {
      challenge: ethers.getBytes(challenge), rpId: location.hostname, timeout: 60000,
      allowCredentials: [{ type: 'public-key', id: unb64url(p.id) }], userVerification,
    } });
  } catch (e) {
    record('webauthn.get.error', { role, ...errInfo(e) });
    throw e;
  }
  check(a, 'Signing cancelled');
  const clientData = new Uint8Array(a.response.clientDataJSON);
  const der = new Uint8Array(a.response.signature), raw = rawDER(der);
  const auth = {
    ...lowS(raw),
    challengeIndex: byteIndexOf(clientData, '"challenge":"'),
    typeIndex: byteIndexOf(clientData, '"type":"'),
    authenticatorData: hexOf(a.response.authenticatorData),
    clientDataJSON: dec.decode(clientData),
  };
  record('webauthn.get.result', {
    role,
    credentialId: a.id,
    authenticatorAttachment: a.authenticatorAttachment,
    userHandle: a.response.userHandle && hexOf(a.response.userHandle),
    clientDataJSON: auth.clientDataJSON,
    authenticatorData: auth.authenticatorData, authData: parseAuthData(auth.authenticatorData),
    signatureDER: hexOf(der),
    sNormalized: BigInt(ethers.hexlify(raw.slice(32))) > N / 2n,
    challengeIndex: auth.challengeIndex, typeIndex: auth.typeIndex,
    clientExtensionResults: a.getClientExtensionResults(),
  });
  return auth;
}

// Handshake: A's passkey signs the statement digest for a block just behind head as its WebAuthn challenge.
async function signAsA() {
  check(mode === 'handshake', 'Switch to Handshake mode to sign A with a passkey');
  const p = passkeyIn('signerKey');
  check(p, 'Enroll a passkey and pick it for A');
  const block = await anchorBlock();
  const maxAge = windowBlocks();
  const digest = ethers.sha256(statementMessage(block.number, block.hash, maxAge));
  status(`A (${p.label}): sign the statement for block ${block.number}…`, 'warn', 'Passkey A');
  const auth = await passkeyAssert('signer', p, digest);
  current = {
    statement: { signer: { x: p.x, y: p.y }, kind: KIND.WEBAUTHN, blockNumber: block.number, blockHash: block.hash, maxAge, signature: encodeAuth(auth) },
    digest,
    signerLabel: p.label,
  };
  evidence = null;
  record('signer.signed', { signer: p.label, keyId: keyId(p), blockNumber: block.number, blockHash: block.hash, maxAge, digest });
  setResult('Signed by A', 'Waiting for B', 'warn');
  $('steps').textContent = `✓ A (${p.label}) signed the statement for block ${block.number} with a window of ${maxAge} blocks\n  digest ${short(digest)}\nB has until block ${block.number + maxAge} to co-sign.`;
  status(`A signed block ${block.number}. Co-sign as B within ${maxAge} blocks.`, 'ok', 'Signed');
}

async function cosignAsB() {
  const p = passkeyIn('cosignerKey');
  check(p, 'Enroll a passkey and pick it for B');
  check(current, mode === 'beacon' ? 'Waiting for the beacon statement' : 'A must sign the statement first');
  check(keyId(p) !== keyId(current.statement.signer), 'A and B are the same passkey. Pick a different one for B; the contract rejects SelfCosign.');
  const snap = structuredClone(current); // the "scanned QR"
  const challenge = cosignChallenge(snap.digest, snap.statement.signer);
  record('cosign.start', {
    signer: { label: snap.signerLabel, keyId: keyId(snap.statement.signer), kind: snap.statement.kind },
    cosigner: { label: p.label, keyId: keyId(p), credentialId: p.id },
    blockNumber: snap.statement.blockNumber, blockHash: snap.statement.blockHash, maxAge: snap.statement.maxAge, digest: snap.digest, challenge,
  });
  status(`B (${p.label}): authorize the co-signature…`, 'warn', 'Passkey B');
  const auth = await passkeyAssert('cosigner', p, challenge);
  evidence = { statement: snap.statement, cosigner: { x: p.x, y: p.y }, auth, signerLabel: snap.signerLabel, cosignerLabel: p.label };
  const flags = ethers.getBytes(auth.authenticatorData)[32];
  let cosignId, age;
  try {
    [cosignId, age] = await vestige.verify(...args(evidence));
  } catch (e) {
    record('verify.error', errInfo(e));
    throw e;
  }
  record('verify.ok', { cosignId, anchor: snap.statement.blockNumber, age, maxAge: snap.statement.maxAge });
  setResult('Verified, not recorded', 'Ready', 'warn');
  $('steps').textContent = [
    `✓ A (${snap.signerLabel}) signed block ${snap.statement.blockNumber} · ${KIND_MODE[snap.statement.kind]} · window ${snap.statement.maxAge}`,
    `✓ B (${p.label}) signed challenge ${short(challenge)}`,
    `  flags UP=${flags & 1 ? 1 : 0} UV=${flags & 4 ? 1 : 0} BE=${flags & 8 ? 1 : 0} BS=${flags & 16 ? 1 : 0}`,
    `✓ Vestige.verify() (eth_call) → cosignId ${short(cosignId)}, age ${age} of ${snap.statement.maxAge}`,
    'Ready to submit cosign().',
  ].join('\n');
  status('Contract accepts this evidence. Submit it to record the co-signature.', 'ok', 'Verified');
  render();
}

async function submit(e, label) {
  check(e, 'Co-sign as B first');
  record('submit.start', { label, anchor: Number(e.statement.blockNumber), ageIfIncludedNext: head + 1 - Number(e.statement.blockNumber), evidence: e });
  try {
    let rc;
    if (serverRelay) rc = await relaySubmit(e);
    else if (browserPayer) rc = await walletSubmit(e);
    else { const tx = await vestige.cosign(...args(e)); showSent(tx.hash); rc = await tx.wait(); }
    const log = rc.logs.map(l => { try { return vestige.interface.parseLog(l); } catch { return null; } }).find(l => l && l.name === 'Cosigned');
    record('submit.ok', { label, tx: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed, cosignId: log.args.cosignId, age: log.args.age, maxAge: log.args.maxAge });
    lastAccepted = structuredClone(e);
    setResult('Recorded on-chain', 'Block #' + rc.blockNumber, 'ok');
    $('steps').append(`\n✓ cosign() included in block ${rc.blockNumber} (age ${log.args.age} of ${log.args.maxAge}), gas ${rc.gasUsed}\n  cosignId ${log.args.cosignId}\n  tx `,
      txLink(rc.hash, NET.explorer ? `${rc.hash} ↗` : rc.hash));
    status(`Recorded. Cosigned event in block ${rc.blockNumber}.`, 'ok', 'Recorded');
    await refreshEvents();
  } catch (err) {
    const why = reason(err);
    // A revert is the contract's verdict; anything else (no funds, RPC error) never reached it.
    const byContract = Boolean(err?.revert || revertData(err));
    record(byContract ? 'submit.rejected' : 'submit.failed', { label, ...errInfo(err), tx: err?.receipt?.hash ?? err?.error?.data?.txHash });
    if (byContract) { rejected.unshift({ at: new Date().toLocaleTimeString(), label, why }); renderRejected(); }
    if (label === 'submit') setResult(byContract ? 'Rejected' : 'Not sent', byContract ? 'Reverted' : 'Failed', 'bad');
    status(byContract ? `${label}: rejected by contract with ${why}` : `${label}: not sent: ${why}`, 'bad', byContract ? 'Rejected' : 'Failed');
  }
}

function showSent(hash) {
  if (NET.local) return; // the local node mines it at once
  $('steps').append('\n… cosign() sent, waiting for inclusion: ', txLink(hash, `${short(hash)} ↗`));
  status(`cosign() sent on ${NET.name}. Waiting for it to be included…`, 'warn', 'Pending');
}

// Sends cosign() through the local server's relayer. Simulating first surfaces the contract's error here, decoded.
async function relaySubmit(e) {
  await vestige.cosign.staticCall(...args(e), { from: serverRelay.address });
  const res = await fetch('/relay', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: NET.chainId, data: vestige.interface.encodeFunctionData('cosign', args(e)) }),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error), { data: body.revert });
  record('relay.sent', { hash: body.hash });
  showSent(body.hash);
  const rc = await provider.waitForTransaction(body.hash);
  check(rc.status === 1, `cosign() reverted on-chain in block ${rc.blockNumber}`);
  return rc;
}

// Sends cosign() from the visitor's own wallet: a WalletConnect session if there is one, else the browser wallet, else
// a new WalletConnect pairing. Simulating against the public RPC first surfaces the contract's error here, decoded,
// before any wallet is asked for anything; the attacks never get further than that.
async function walletSubmit(e) {
  const [cosignId] = await vestige.cosign.staticCall(...args(e));
  if (!wcAccount && !window.ethereum) await connectWalletConnect();
  const eip = wcAccount ? wc : window.ethereum;
  const from = wcAccount ?? ethers.getAddress((await eip.request({ method: 'eth_requestAccounts' }))[0]);
  const chainId = ethers.toQuantity(NET.chainId);
  if (Number(await eip.request({ method: 'eth_chainId' })) !== NET.chainId) {
    status(`Switch the wallet to ${NET.name}…`, 'warn', 'Wallet');
    try {
      await eip.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (err) {
      if (eip === wc) throw new Error(`The wallet did not switch to ${NET.name}: ${reason(err)}. Disconnect WalletConnect and pair again, approving ${NET.name}.`);
      if (err?.code !== 4902) throw err;
      await eip.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: NET.name, rpcUrls: [NET.rpc], nativeCurrency: { name: 'ETH', symbol: NET.native ?? 'ETH', decimals: 18 }, blockExplorerUrls: [NET.explorer] }] });
    }
    const active = Number(await eip.request({ method: 'eth_chainId' }));
    check(active === NET.chainId, `The wallet is on chain ${active}, not ${NET.name} (${NET.chainId})`);
  }
  const data = vestige.interface.encodeFunctionData('cosign', args(e));
  const gas = await provider.estimateGas({ from, to: D.address, data });
  status(`Confirm cosign() in your wallet${eip === wc ? ' (check your phone)' : ''}…`, 'warn', 'Wallet');
  const hash = await eip.request({ method: 'eth_sendTransaction', params: [{ from, to: D.address, data, gas: ethers.toQuantity(gas * 12n / 10n) }] });
  record('wallet.sent', { hash, from, via: eip === wc ? 'WalletConnect' : 'browser wallet' });
  showSent(hash);
  const rc = await waitForCosign(hash, cosignId);
  check(rc.status === 1, `cosign() reverted on-chain in block ${rc.blockNumber}`);
  return rc;
}

// A smart-account wallet may return a user-operation hash rather than a transaction hash, so this also watches for
// the record itself and reads the receipt of whichever transaction made it.
async function waitForCosign(hash, cosignId) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const rc = await provider.getTransactionReceipt(hash).catch(() => null);
    if (rc) return rc;
    if (await vestige.recorded(cosignId)) {
      const latest = await provider.getBlockNumber();
      const [log] = await vestige.queryFilter(vestige.filters.Cosigned(cosignId), Math.max(0, latest - NET.logRange + 1), latest);
      if (log) return provider.getTransactionReceipt(log.transactionHash);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`No receipt for ${short(hash)} after 5 minutes. Check it on the explorer; reload to see the record if it landed.`);
}

// ---- WalletConnect ----
// For visitors without a browser wallet, or who would rather pay from a phone. Same Reown project as /deploy.html; its
// allowed origins must include this site. The bundle (web/vendor/wallet.js) loads only when it is needed.
const WC_PROJECT_ID = 'b6e2a9dea4c173bca01c645f4a241a16';
const WC_SESSION = 'vestige-lab-wc-session';
let wc = null, wcAccount = null, pairingUri = '', relayError = null, cancelPairing = null;

function loadWalletBundle() {
  if (window.VestigeWallet) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/wallet.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('The WalletConnect bundle did not load. Run npm run deploy:build.'));
    document.head.append(script);
  });
}

async function initWc() {
  await loadWalletBundle();
  const remote = Object.values(NETWORKS).filter(n => !n.local);
  const p = await window.VestigeWallet.EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    showQrModal: false,
    optionalChains: remote.map(n => n.chainId),
    rpcMap: Object.fromEntries(remote.map(n => [n.chainId, n.rpc])),
    metadata: { name: 'Vestige Lab', description: 'Pays for cosign(): records a passkey co-signature on a testnet', url: location.origin, icons: [location.origin + '/assets/favicon.svg'] },
  });
  p.on('display_uri', showPairing);
  p.signer?.client?.core?.relayer?.on?.('relayer_error', err => { relayError = err?.message ?? String(err); record('wallet.relay.error', { error: relayError }); });
  // Wallets re-announce the same account on every chain switch; only a different account is news.
  p.on('accountsChanged', a => { if (a[0] && ethers.getAddress(a[0]) !== wcAccount) { wcAccount = ethers.getAddress(a[0]); renderPayer(); } });
  p.on('disconnect', () => { wcAccount = null; rememberSession(false); record('wallet.disconnected', { via: 'WalletConnect' }); renderPayer(); });
  return p;
}

async function connectWalletConnect() {
  wc ??= await initWc();
  if (!wc.session) {
    status('Opening a WalletConnect session…', 'warn', 'Pairing');
    try {
      await new Promise((resolve, reject) => {
        // The SDK retries a refused relay connection forever; give up if no pairing code arrives.
        const timer = setTimeout(() => {
          const relay = relayError ? ` The relay answered: “${relayError}”.` : '';
          reject(new Error(`WalletConnect produced no pairing code within 20 s.${relay} ${location.origin} may not be an allowed origin for this project.`));
        }, 20000);
        showPairing.onShown = () => clearTimeout(timer);
        cancelPairing = () => { clearTimeout(timer); reject(new Error('Pairing cancelled')); };
        wc.connect().then(resolve, reject).finally(() => clearTimeout(timer));
      });
    } finally {
      cancelPairing = null;
      $('pair').hidden = true;
    }
  }
  wcAccount = ethers.getAddress(wc.accounts[0]);
  rememberSession(true);
  record('wallet.connected', { via: 'WalletConnect', account: wcAccount });
  status(`Connected ${short(wcAccount)} via WalletConnect. It pays for cosign() on ${NET.name}.`, 'ok', 'Wallet');
  renderPayer();
}

function showPairing(uri) {
  pairingUri = uri;
  showPairing.onShown?.();
  const qr = window.VestigeWallet.qrcode(0, 'M');
  qr.addData(uri); qr.make();
  $('qr').src = qr.createDataURL(6, 2);
  $('openWallet').href = uri;
  $('pair').hidden = false;
  $('pair').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  status('Scan the QR code with your wallet, or open or copy the pairing link.', 'warn', 'Pairing');
}

async function disconnectWalletConnect() {
  await wc?.disconnect().catch(() => {});
  wcAccount = null;
  rememberSession(false);
  renderPayer();
}

function renderPayer() {
  if (!browserPayer) return;
  $('relayer').textContent = wcAccount
    ? `${wcAccount} via WalletConnect: it pays ${NET.name} gas when you submit.`
    : window.ethereum
      ? `Your browser wallet pays ${NET.name} gas when you submit, or pay from a phone with WalletConnect. Signing and verify() need no wallet.`
      : `A wallet you pair over WalletConnect pays ${NET.name} gas when you submit. Signing and verify() need no wallet.`;
  $('payerRow').hidden = false;
  $('wcConnect').hidden = Boolean(wcAccount);
  $('wcDisconnect').hidden = !wcAccount;
}

// The SDK keeps sessions in IndexedDB; this flag only says one exists, so a visit without one never loads the bundle.
function rememberSession(on) {
  try { on ? localStorage.setItem(WC_SESSION, '1') : localStorage.removeItem(WC_SESSION); } catch {}
}

// Restores a WalletConnect session from an earlier visit without asking.
async function restoreWalletConnect() {
  let stored = false;
  try { stored = localStorage.getItem(WC_SESSION) === '1'; } catch {}
  if (!stored) return;
  try {
    wc = await initWc();
    if (wc.session && wc.accounts[0]) { wcAccount = ethers.getAddress(wc.accounts[0]); renderPayer(); }
    else rememberSession(false);
  } catch (err) { record('wallet.restore.error', { error: reason(err) }); }
}

// The contract checks the anchor's age before anything else, so an attack built on stale evidence
// would only ever report StaleBlock and never reach the check it targets.
async function assertFresh(e, label) {
  const age = await freshHead() + 1 - Number(e.statement.blockNumber), maxAge = Number(e.statement.maxAge);
  check(age <= maxAge, `${label}: evidence is ${age} blocks old (window ${maxAge}), so the contract would stop at StaleBlock before the check this attack targets. Co-sign again first.`);
}

async function variant(base, mutate, label) {
  check(base, 'Co-sign as B first');
  await assertFresh(base, label);
  const e = structuredClone(base);
  mutate(e);
  return e;
}

// ---- rendering ----
function setTag(el, text, kind) {
  el.textContent = text;
  el.className = 'st' + (kind ? ' st--' + kind : '');
}

function status(text, kind = '', tag) {
  tag = tag || { ok: 'OK', bad: 'Error', warn: 'Waiting' }[kind] || 'Info';
  $('statusText').textContent = text;
  setTag($('statusTag'), tag, kind);
  $('status').className = 'status' + (kind === 'bad' ? ' status--bad' : '');
  record('status', { kind, tag, text });
}

function setResult(label, tag, kind) {
  $('resultLabel').textContent = label;
  setTag($('result'), tag, kind);
}

// ethers surfaces revert data at different depths depending on whether simulation or sending failed.
function revertData(e) {
  return [e?.data, e?.info?.error?.data, e?.info?.error?.data?.data, e?.error?.data, e?.error?.data?.data]
    .find(d => typeof d === 'string' && d.length >= 10);
}

function reason(e) {
  if (e?.revert) return e.revert.name + (e.revert.args.length ? '(' + e.revert.args.map(a => { const s = String(a); return s.length > 20 ? short(s) : s; }).join(', ') + ')' : '');
  const data = revertData(e);
  if (data && vestige) { try { const p = vestige.interface.parseError(data); if (p) return reason({ revert: p }); } catch {} }
  if (e?.name === 'NotAllowedError') return 'Passkey prompt cancelled or timed out';
  // ethers wraps RPC errors it cannot classify (Monad's "insufficient balance", for one); the node's text is clearer.
  if (e?.code === 'UNKNOWN_ERROR' && e?.error?.message) return e.error.message;
  return e?.shortMessage || e?.message || String(e);
}

function fillPasskeySelect(sel, list, keep) {
  sel.replaceChildren();
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = `${p.label} · ${short(keyId(p))}`;
    sel.append(o);
  }
  if (!list.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'No passkey enrolled';
    sel.append(o);
  }
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}

// Keeps A and B on different passkeys when there are at least two.
function renderPasskeys(justEnrolled) {
  const list = loadPasskeys();
  const a = $('signerKey').value, b = $('cosignerKey').value;
  fillPasskeySelect($('passkeys'), list, justEnrolled || $('passkeys').value);
  fillPasskeySelect($('signerKey'), list, a || list[0]?.id);
  fillPasskeySelect($('cosignerKey'), list, justEnrolled && list.length > 1 ? justEnrolled : b || list[1]?.id || list[0]?.id);
  if (list.length > 1 && $('signerKey').value === $('cosignerKey').value) {
    $('cosignerKey').value = list.find(p => p.id !== $('signerKey').value).id;
  }
  $('passkeyCount').textContent = list.length ? `${list.length} enrolled` : 'None enrolled';
}

function renderMode() {
  $('modeBeacon').setAttribute('aria-pressed', String(mode === 'beacon'));
  $('modeHandshake').setAttribute('aria-pressed', String(mode === 'handshake'));
  document.querySelectorAll('.only-beacon').forEach(el => { el.hidden = mode !== 'beacon'; });
  document.querySelectorAll('.only-handshake').forEach(el => { el.hidden = mode !== 'handshake'; });
  $('aName').textContent = mode === 'beacon' ? 'Beacon' : 'Signer passkey';
  $('aBar').textContent = mode === 'beacon' ? 'signer · beacon device key' : 'signer · webauthn passkey';
  $('modeNote').textContent = mode === 'beacon'
    ? 'A signs every block without a prompt. You only tap for B.'
    : `A taps to sign once; B has ${blocksText(windowBlocks())} to co-sign.`;
}

function renderRejected() {
  const items = rejected.slice(0, 50).map(r => {
    const li = document.createElement('li');
    const at = document.createElement('span'), what = document.createElement('span'), st = document.createElement('span');
    at.className = 'log__time'; at.textContent = r.at;
    what.className = 'log__what'; what.textContent = r.label;
    setTag(st, r.why, 'bad'); st.title = r.why;
    li.append(at, what, st);
    return li;
  });
  $('rejected').replaceChildren(...items);
}

function render() {
  const s = current?.statement;
  $('aKey').textContent = s ? `${current.signerLabel} · ${keyId(s.signer)}` : mode === 'beacon' ? 'Beacon key loading…' : 'Not signed yet';
  $('aKind').textContent = s ? (s.kind === KIND.P256 ? 'P256 · raw ECDSA (WebCrypto)' : 'WebAuthn · passkey assertion') : '—';
  $('aBlock').textContent = s ? `#${s.blockNumber}` + (mode === 'beacon' && $('freeze').checked ? ' (frozen)' : '') : '—';
  $('aWindow').textContent = s ? `${blocksText(Number(s.maxAge))} · until #${Number(s.blockNumber) + Number(s.maxAge)}` : '—';
  $('aHash').textContent = s ? s.blockHash : '—';
  $('aDigest').textContent = current ? current.digest : '—';
  $('aSig').textContent = !s ? '—' : s.kind === KIND.P256
    ? `r ${short(ethers.dataSlice(s.signature, 0, 32))}  s ${short(ethers.dataSlice(s.signature, 32))}`
    : `assertion · ${ethers.dataLength(s.signature)} bytes`;
  $('head').textContent = '#' + head;
  setTag($('net'), 'Block #' + head, 'ok');

  // Age of what would be submitted: the co-signed evidence, else A's statement waiting for B.
  const pending = evidence?.statement ?? (mode === 'handshake' ? s : undefined);
  if (pending) {
    const age = head + 1 - Number(pending.blockNumber), maxAge = Number(pending.maxAge); // the cosign tx lands in the next block
    $('meterFill').style.width = Math.min(100, age / maxAge * 100) + '%';
    $('meter').className = 'meter' + (age > maxAge ? ' meter--dead' : age > maxAge * 0.75 ? ' meter--late' : '');
    $('age').textContent = `Statement age ${age} / ${maxAge} blocks if submitted now` + (age > maxAge ? ' · stale' : '');
  } else {
    $('meterFill').style.width = '0';
    $('meter').className = 'meter';
    $('age').textContent = mode === 'beacon' ? 'Fresh every block until B co-signs' : 'No statement yet';
  }
  $('payload').textContent = evidence ? JSON.stringify({ statement: evidence.statement, cosigner: evidence.cosigner, auth: evidence.auth }, null, 2) : 'None';
}

// Logs are read once and appended: public RPCs cap a request at 100-5000 blocks, so each refresh reads only new blocks.
let logCursor = null, cosignLogs = [];
async function refreshEvents() {
  const to = head - NET.anchorLag + 1;
  if (logCursor === null) logCursor = Math.max(D.deployBlock, to - (NET.lookback ?? Infinity));
  while (logCursor <= to) {
    const end = Math.min(to, logCursor + NET.logRange - 1);
    cosignLogs.push(...await vestige.queryFilter(vestige.filters.Cosigned(), logCursor, end));
    logCursor = end + 1;
  }
  const logs = cosignLogs.slice();
  const passkeys = new Map(loadPasskeys().map(p => [keyId(p), p.label]));
  const name = id => (beacon && id === keyId(beacon.pub)) ? ['This beacon', 'me'] : passkeys.has(id) ? [passkeys.get(id), 'me'] : [short(id)];
  const rows = logs.reverse().slice(0, 100).map(l => {
    const tr = document.createElement('tr');
    const cells = [
      ['#' + l.blockNumber], ['#' + l.args.blockNumber], [`${l.args.age} / ${l.args.maxAge}`],
      [KIND_MODE[Number(l.args.signerKind)] ?? '?'],
      name(l.args.signerKey), name(l.args.cosignerKey),
      [short(l.args.cosignId)], [txLink(l.transactionHash)],
    ];
    for (const [content, cls] of cells) { const td = document.createElement('td'); td.append(content); if (cls) td.className = cls; tr.append(td); }
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 8; td.className = 'empty'; td.textContent = 'No co-signatures recorded yet.';
    tr.append(td); rows.push(tr);
  }
  $('events').replaceChildren(...rows);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const n = await freshHead();
    if (n < head && NET.local) {
      check(await provider.getCode(D.address) !== '0x', 'Chain was reset and Vestige is gone. Run npm run deploy, then reload.');
    }
    // Public RPCs are load-balanced and can answer from a node a block behind; never step the head backwards there.
    if (n !== head && (NET.local || n > head)) {
      head = n;
      if (mode === 'beacon' && !$('freeze').checked && head > NET.anchorLag) await signBeacon(await anchorBlock(head));
      if (!busy) await refreshEvents();
    }
    if (online === false) record('node.online', { head });
    online = true;
    render();
  } catch (e) {
    setTag($('net'), 'Offline', 'bad');
    if (online !== false) {
      record('node.offline', errInfo(e));
      status('Node unreachable or reset: ' + reason(e), 'bad', 'Offline');
    }
    online = false;
  } finally {
    ticking = false;
  }
}

async function run(fn) {
  if (busy) return;
  busy = true;
  const buttons = document.querySelectorAll('main button:not([data-always])');
  buttons.forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { status(reason(e), 'bad'); }
  finally { busy = false; buttons.forEach(b => b.disabled = false); render(); }
}

async function setMode(next) {
  if (next === mode) return;
  mode = next;
  try { localStorage.setItem(MODE, mode); } catch {}
  current = null;
  evidence = null;
  record('mode', { mode });
  if (mode === 'beacon') await signBeacon(await anchorBlock());
  renderMode();
  setResult('Not recorded', 'Idle', '');
  $('steps').textContent = mode === 'beacon'
    ? 'The beacon signs every block. Co-sign as B.'
    : 'Sign as A with one passkey, then co-sign as B with another.';
  const count = loadPasskeys().length;
  status(mode === 'beacon'
    ? 'Beacon mode: the device key signs every block. Co-sign as B with a passkey.'
    : count < 2 ? `Handshake mode needs two passkeys; ${count} enrolled. Enroll ${2 - count} more.` : 'Handshake mode: sign as A, then co-sign as B with the other passkey.',
  count < 2 && mode === 'handshake' ? 'warn' : 'ok', MODE_LABEL[mode]);
}
const MODE_LABEL = { beacon: 'Beacon', handshake: 'Handshake' };

// ---- theme: light by default (not the system's), toggle persists per browser ----
function effectiveTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function renderThemeButton() { $('theme').textContent = effectiveTheme() === 'dark' ? 'Light' : 'Dark'; }
$('theme').onclick = () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('vestige-theme', next); } catch {}
  renderThemeButton();
};
renderThemeButton();

// ---- wiring ----
$('modeBeacon').onclick = () => run(() => setMode('beacon'));
$('modeHandshake').onclick = () => run(() => setMode('handshake'));
$('enroll').onclick = () => run(enroll);
$('forget').onclick = () => run(async () => {
  const p = passkeyIn('passkeys'); check(p, 'No passkey selected');
  savePasskeys(loadPasskeys().filter(x => x.id !== p.id)); renderPasskeys();
  record('passkey.forget', { label: p.label, keyId: keyId(p) });
  status(`Forgot “${p.label}” in this page. The passkey itself stays in your authenticator.`, 'ok', 'Removed');
});
$('signerKey').onchange = () => { if (mode === 'handshake') { current = null; evidence = null; render(); } };
$('signA').onclick = () => run(signAsA);
$('cosign').onclick = () => run(async () => { setResult('Not recorded', 'Signing', 'warn'); await cosignAsB(); });
$('submit').onclick = () => run(() => submit(evidence, 'submit'));
$('wcConnect').onclick = () => run(connectWalletConnect);
$('wcDisconnect').onclick = () => run(disconnectWalletConnect);
// Both work while pairing holds the lab busy.
$('copyUri').onclick = () => navigator.clipboard.writeText(pairingUri).then(() => status('Pairing link copied. Paste it into the wallet.', 'ok', 'Copied'), e => status(reason(e), 'bad'));
$('cancelPair').onclick = () => cancelPairing?.();
$('replay').onclick = () => run(async () => {
  check(lastAccepted, 'Record a co-signature first');
  await assertFresh(lastAccepted, 'replay');
  await submit(lastAccepted, 'replay');
});
$('stale').onclick = () => run(async () => {
  check(evidence, 'Co-sign as B first');
  const blocks = Number(evidence.statement.maxAge);
  if (NET.local) {
    await provider.send('hardhat_mine', [ethers.toQuantity(blocks)]);
    record('hardhat_mine', { blocks, headAfter: await freshHead() }); // tick() re-signs the beacon for the new head
  } else {
    // A public chain cannot be mined on demand: wait until the evidence is past its window, if that is quick.
    const deadline = Number(evidence.statement.blockNumber) + blocks; // last block it may be included in
    const wait = (deadline - await freshHead()) * NET.blockSeconds;
    check(wait <= 180, `The window ends in ${duration(deadline - head)}. Set a window of at most ${Math.floor(120 / NET.blockSeconds)} blocks and co-sign again to try this.`);
    status(`Waiting for block ${deadline} so the evidence is past its window (${duration(Math.max(0, deadline - head))})…`, 'warn', 'Waiting');
    while (await freshHead() < deadline) await new Promise(r => setTimeout(r, 1000));
    record('stale.waited', { deadline, head: await freshHead() });
  }
  await submit(evidence, 'stale anchor');
});
// The relayer (or B) widens A's window after the fact; A's signature covers it, so the signer check fails.
$('stretch').onclick = () => run(async () => submit(await variant(evidence, e => { e.statement.maxAge = 8191; }, 'stretched window'), 'stretched window'));
$('forge').onclick = () => run(async () => submit(await variant(evidence, e => { e.statement.blockHash = ethers.hexlify(ethers.randomBytes(32)); }, 'forged block hash'), 'forged block hash'));
$('swapSigner').onclick = () => run(async () => submit(await variant(evidence, e => { e.statement.signer = stranger; }, 'wrong signer key'), 'wrong signer key'));
$('swapCosigner').onclick = () => run(async () => submit(await variant(evidence, e => { e.cosigner = stranger; }, 'wrong cosigner key'), 'wrong cosigner key'));
$('selfCosign').onclick = () => run(async () => submit(await variant(evidence, e => { e.cosigner = e.statement.signer; }, 'self co-sign'), 'self co-sign'));
$('window').onchange = () => run(async () => {
  $('window').value = String(windowBlocks());
  try { localStorage.setItem(WINDOW, $('window').value); } catch {}
  record('signer.window', { maxAge: windowBlocks() });
  renderMode();
  if (mode === 'beacon' && !$('freeze').checked && head > NET.anchorLag) await signBeacon(await anchorBlock(head));
  render();
  status(`A now signs with a window of ${windowBlocks()} blocks.` + (mode === 'handshake' ? ' Sign as A again to apply it.' : ''), 'ok', 'Window');
});
$('freeze').onchange = () => { record('beacon.freeze', { frozen: $('freeze').checked, anchor: current?.statement.blockNumber }); render(); };

// ---- source: the compiled files, checked against the code at the contract's address ----
let SRC = null;
const SOL_KEYWORDS = new Set(('pragma solidity import from as contract library interface abstract is using for struct enum ' +
  'event error function modifier constructor returns return if else while do break continue revert emit require assert ' +
  'public private internal external pure view payable constant immutable memory calldata storage override virtual ' +
  'unchecked assembly let new delete try catch true false indexed anonymous').split(' '));
const SOL_TYPE = /^(?:u?int\d*|bytes\d*|bool|address|string|mapping)$/;
const SOL_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(0x[0-9a-fA-F]+|\d[\d_]*(?:e\d+)?)\b|\b([A-Za-z_]\w*)\b/g;
const escapeHTML = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One escaped HTML string per line; a token spanning lines (a block comment) is split at each newline.
function highlightLines(src) {
  const lines = [''];
  const push = (text, cls) => text.split('\n').forEach((part, i) => {
    if (i) lines.push('');
    if (part) lines[lines.length - 1] += cls ? `<span class="${cls}">${escapeHTML(part)}</span>` : escapeHTML(part);
  });
  let last = 0;
  for (const m of src.matchAll(SOL_TOKEN)) {
    const [text, comment, string, number, word] = m;
    push(src.slice(last, m.index));
    push(text, comment ? 'c' : string ? 's' : number ? 'n' : SOL_KEYWORDS.has(word) ? 'k' : SOL_TYPE.test(word) ? 't' : '');
    last = m.index + text.length;
  }
  push(src.slice(last));
  return lines;
}

function showFile(path) {
  const content = SRC.sources[path], meta = SRC.meta.sources[path];
  $('code').innerHTML = highlightLines(content).map(l => `<span class="line">${l}</span>`).join('');
  $('code').scrollTop = 0;
  $('fileTitle').textContent = path;
  $('fileFacts').textContent = `${content.split('\n').length} lines · keccak256 ${short(meta?.keccak256)}` + (meta?.license ? ` · ${meta.license}` : '');
  $('downloadSource').dataset.path = path;
  document.querySelectorAll('#files button').forEach(b => b.setAttribute('aria-current', String(b.dataset.path === path)));
}

function renderFiles() {
  const nav = $('files');
  nav.replaceChildren();
  let group;
  for (const path of Object.keys(SRC.sources)) {
    const g = path.startsWith('@openzeppelin/') ? `OpenZeppelin ${SRC.packages['@openzeppelin/contracts']}` : 'Vestige';
    if (g !== group) {
      const h = document.createElement('span');
      h.className = 'files__group'; h.textContent = g;
      nav.append(h);
      group = g;
    }
    const b = document.createElement('button'), name = document.createElement('span'), dir = document.createElement('small');
    b.type = 'button'; b.dataset.path = path; b.dataset.always = '';
    name.textContent = path.split('/').pop();
    dir.textContent = path.split('/').slice(0, -1).join('/');
    b.append(name, dir);
    b.onclick = () => showFile(path);
    nav.append(b);
  }
}

// solc embeds the metadata's IPFS hash: the CIDv0 multihash of a single-chunk UnixFS file.
async function ipfsMultihash(text) {
  const data = enc.encode(text);
  check(data.length < 262144, 'Metadata larger than one IPFS chunk');
  const varint = n => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Uint8Array.from(o); };
  const unixfs = ethers.getBytes(ethers.concat([Uint8Array.from([0x08, 0x02, 0x12]), varint(data.length), data, Uint8Array.from([0x18]), varint(data.length)]));
  const node = ethers.getBytes(ethers.concat([Uint8Array.from([0x0a]), varint(unixfs.length), unixfs]));
  return ethers.concat(['0x1220', new Uint8Array(await crypto.subtle.digest('SHA-256', node))]);
}

// Reads a fixed-size value after `prefix` in the CBOR solc appends to runtime code (its length is the last 2 bytes).
function cborField(code, prefix, size) {
  const cbor = code.slice(code.length - 2 - ((code[code.length - 2] << 8) | code[code.length - 1]), code.length - 2);
  outer: for (let i = 0; i + prefix.length + size <= cbor.length; i++) {
    for (let j = 0; j < prefix.length; j++) if (cbor[i + j] !== prefix[j]) continue outer;
    return cbor.slice(i + prefix.length, i + prefix.length + size);
  }
  return null;
}

async function verifySource() {
  const checks = [];
  const add = (ok, title, detail) => checks.push({ ok: !!ok, title, detail });
  const onchain = ethers.getBytes(await provider.getCode(D.address));
  const compiled = ethers.getBytes(SRC.runtimeBytecode);

  // Immutables are written into the code at deploy time; mask them and read their values instead.
  const masked = onchain.slice(), values = {};
  for (const { name, refs } of SRC.immutables) {
    const words = refs.map(({ start, length }) => ethers.hexlify(onchain.slice(start, start + length)));
    values[name] = { word: words[0], consistent: words.every(w => w === words[0]) };
    for (const { start, length } of refs) masked.fill(0, start, start + length);
  }
  const slots = SRC.immutables.reduce((n, i) => n + i.refs.length, 0);
  add(onchain.length === compiled.length && masked.every((v, i) => v === compiled[i]) && Object.values(values).every(v => v.consistent),
    'Runtime bytecode matches the compiler output', `${onchain.length} bytes at ${D.address} · ` + (slots ? `${slots} immutable slots masked` : 'exact, nothing masked'));

  add(!SRC.immutables.length && !SRC.constructorInputs,
    'No constructor arguments or immutables', 'Same build, same code on every chain: no per-deployment settings to read or trust');

  const ipfs = cborField(onchain, [0x64, ...enc.encode('ipfs'), 0x58, 0x22], 34);
  const solc = cborField(onchain, [0x64, ...enc.encode('solc'), 0x43], 3);
  const solcVersion = solc ? [...solc].join('.') : '?';
  const computed = await ipfsMultihash(SRC.metadata);
  add(ipfs && ethers.hexlify(ipfs) === computed && SRC.compiler.startsWith(solcVersion + '+'),
    'Metadata hash in the bytecode matches this build', `ipfs ${ethers.encodeBase58(computed)} · solc ${solcVersion}`);

  const listed = Object.keys(SRC.meta.sources);
  const bad = listed.filter(p => SRC.sources[p] === undefined || ethers.keccak256(ethers.toUtf8Bytes(SRC.sources[p])) !== SRC.meta.sources[p].keccak256);
  add(!bad.length && listed.length === Object.keys(SRC.sources).length,
    `All ${listed.length} source files match the metadata`, bad.length ? 'Mismatch: ' + bad.join(', ') : 'keccak256 of every file below equals its entry in the compiler metadata');
  return checks;
}

function renderChecks(checks) {
  $('checks').replaceChildren(...checks.map(c => {
    const li = document.createElement('li'), st = document.createElement('span'), title = document.createElement('span'), detail = document.createElement('span');
    setTag(st, c.ok ? 'Pass' : 'Fail', c.ok ? 'ok' : 'bad');
    title.textContent = c.title;
    detail.className = 'checks__detail'; detail.textContent = c.detail;
    li.append(st, title, detail);
    return li;
  }));
  const ok = checks.every(c => c.ok);
  setTag($('verifyTag'), ok ? 'Verified' : 'Mismatch', ok ? 'ok' : 'bad');
}

function renderBuildFacts() {
  const { optimizer, evmVersion } = SRC.settings;
  const facts = [
    ['Contract', SRC.contract],
    ['Compiler', 'solc ' + SRC.compiler],
    ['Optimizer', optimizer?.enabled ? `enabled · ${optimizer.runs} runs` : 'disabled'],
    ['EVM', evmVersion],
    ['Libraries', `@openzeppelin/contracts ${SRC.packages['@openzeppelin/contracts']}`],
  ];
  $('buildFacts').replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v;
    return [dt, dd];
  }));
}

async function loadSource() {
  const res = await fetch('/contract-source.json', { cache: 'no-store' });
  check(res.ok, 'No source bundle. Run npm run deploy, or npx hardhat run scripts/export-source.js for the current deployment.');
  SRC = await res.json();
  SRC.meta = JSON.parse(SRC.metadata);
  renderFiles();
  showFile(Object.keys(SRC.sources)[0]);
  renderBuildFacts();
  const checks = await verifySource();
  renderChecks(checks);
  record('source.verify', { address: D.address, verified: checks.every(c => c.ok), checks: checks.map(({ ok, title, detail }) => ({ ok, title, detail })) });
}

$('downloadSource').onclick = () => {
  const path = $('downloadSource').dataset.path;
  if (!SRC || !path) return;
  const url = URL.createObjectURL(new Blob([SRC.sources[path]], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function downloadLog() {
  const out = {
    format: 'vestige-lab-log/3',
    exportedAt: new Date().toISOString(),
    note: 'Public data only: credential ids, public keys, signatures, clientDataJSON. Private keys are non-extractable and never leave their stores.',
    origin: location.origin,
    userAgent: navigator.userAgent,
    network: NET_KEY,
    rpc: RPC,
    mode,
    deployment: D && { address: D.address, chainId: D.chainId, deployBlock: D.deployBlock },
    window: windowBlocks(),
    head,
    beaconKeyId: beacon && keyId(beacon.pub),
    passkeys: loadPasskeys().map(p => ({ ...p, keyId: keyId(p) })),
    evidence,
    lastAccepted,
    journal,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, toJSON, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `vestige-lab-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('downloadLog').onclick = downloadLog;
$('clearLog').onclick = () => {
  if (!confirm('Clear the session log stored in this browser?')) return;
  journal = [];
  try { localStorage.removeItem(JOURNAL); } catch {}
  record('log.cleared');
};
window.addEventListener('error', e => record('page.error', { message: e.message, source: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', e => record('page.unhandledrejection', errInfo(e.reason)));

function renderNetworkPicker() {
  const sel = $('network');
  sel.replaceChildren(...Object.entries(NETWORKS).map(([key, n]) => {
    const o = document.createElement('option');
    o.value = key; o.textContent = n.name;
    return o;
  }));
  sel.value = NET_KEY;
  sel.onchange = () => {
    const next = new URLSearchParams(location.search);
    if (sel.value === (ON_LOCALHOST ? 'local' : 'baseSepolia')) next.delete('net'); else next.set('net', sel.value);
    location.search = next.toString();
  };
}

async function init() {
  renderMode();
  check(window.isSecureContext, 'Open this page at http://localhost or over HTTPS so passkeys work.');
  renderNetworkPicker();
  let relayer;
  if (NET.local) {
    const res = await fetch('/deployment.json', { cache: 'no-store' });
    check(res.ok, 'No deployment found. Start the node and run npm run deploy.');
    D = await res.json();
    check(D.abi.some(f => f.name === 'MAX_AGE_LIMIT') && !D.abi.some(f => f.type === 'constructor' && f.inputs.length),
      'deployment.json is from an older contract. Run npm run deploy, then reload.');
    provider = new ethers.JsonRpcProvider(RPC, D.chainId, { staticNetwork: true, pollingInterval: 500 });
    check(await provider.getCode(D.address) !== '0x', `No contract at ${D.address}. Node restarted? Run npm run deploy.`);
    relayer = await provider.getSigner(0);
  } else {
    const res = await fetch('/deploy-bundle.json', { cache: 'no-store' });
    check(res.ok, 'No deploy bundle. Run npm run deploy:build.');
    const bundle = await res.json();
    check(bundle.abi, 'The deploy bundle predates the lab\'s network support. Run npm run deploy:build.');
    D = { address: bundle.address, chainId: NET.chainId, deployBlock: NET.deployBlock, abi: bundle.abi };
    provider = new ethers.JsonRpcProvider(RPC, NET.chainId, { staticNetwork: true, batchMaxCount: 1, pollingInterval: 1000 });
    check(Number(await provider.send('eth_chainId', [])) === NET.chainId, `${RPC} does not serve ${NET.name}`);
    check(await provider.getCode(D.address) === bundle.runtimeBytecode, `Vestige is not deployed on ${NET.name} at ${D.address}. Deploy it from /deploy.html first.`);
    // Only scripts/serve.js has a relayer; a static host has none to ask.
    const relayInfo = ON_LOCALHOST ? await fetch('/relay', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null) : null;
    if (relayInfo?.chains.includes(NET.chainId)) {
      serverRelay = relayInfo;
      relayer = { address: relayInfo.address };
    } else {
      let key = null;
      try { key = localStorage.getItem(TEST_WALLET); } catch {}
      if (key) relayer = new ethers.Wallet(key, provider);
      else browserPayer = true;
    }
  }
  vestige = new ethers.Contract(D.address, D.abi, serverRelay || browserPayer ? provider : relayer);
  beacon = await loadBeaconKey();
  // A valid P-256 point no participant controls, for the wrong-key attacks.
  stranger = await publicPoint((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])).publicKey);

  const latest = await provider.getBlock('latest');
  check(await vestige.statementMessage(latest.number, latest.hash, WINDOW_DEFAULT) === statementMessage(latest.number, latest.hash, WINDOW_DEFAULT),
    'Client and contract statement encodings differ');

  $('rpc').textContent = RPC;
  $('chainId').textContent = `${NET.name} · ${D.chainId}` + (blockSeconds() ? ` · block every ${blockSeconds()} s` : '');
  $('address').textContent = D.address;
  $('chainBar').textContent = `vestige.sol · ${NET.local ? 'local node' : NET.name}`;
  $('stale').textContent = NET.local ? 'Mine past the window, submit' : 'Wait out the window, submit';
  $('policy').textContent = `Window set per statement by A (1–${await vestige.MAX_AGE_LIMIT()} blocks) · UV always required`;
  $('stripNet').textContent = NET.local ? 'Real contract on a local node' : `Real contract on ${NET.name}`;
  if (NET.local) $('relayer').textContent = relayer.address + ' (node account, submits for B)';
  else if (browserPayer) { renderPayer(); restoreWalletConnect(); }
  else {
    const balance = await provider.send('eth_getBalance', [relayer.address, 'latest']).then(BigInt);
    $('relayer').textContent = `${relayer.address} (${serverRelay ? 'local server, key from .env' : 'test wallet from /deploy.html'}, submits for B) · ${Number(ethers.formatEther(balance)).toFixed(4)} left`;
    if (balance === 0n) status(`The relayer has no funds on ${NET.name}; cosign() will fail. Fund ${relayer.address}.`, 'bad', 'Relayer');
  }
  renderPasskeys();
  renderMode();
  record('init', {
    origin: location.origin, rpId: location.hostname, network: NET_KEY, rpc: RPC, userAgent: navigator.userAgent,
    deployment: { address: D.address, chainId: D.chainId, deployBlock: D.deployBlock },
    window: windowBlocks(),
    beaconKeyId: keyId(beacon.pub), relayer: browserPayer ? 'browser wallet' : relayer.address, passkeys: loadPasskeys().length,
    platformAuthenticator: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => null),
    clientCapabilities: await PublicKeyCredential.getClientCapabilities?.().catch(() => null),
  });
  loadSource().catch(e => {
    setTag($('verifyTag'), 'Unavailable', 'bad');
    const li = document.createElement('li');
    li.className = 'log__empty'; li.textContent = reason(e);
    $('checks').replaceChildren(li);
    record('source.error', errInfo(e));
  });
  await tick();
  setInterval(tick, 1000);
  const count = loadPasskeys().length;
  if (mode === 'handshake' && count < 2) status(`Handshake mode needs two passkeys; ${count} enrolled. Enroll ${2 - count} more.`, 'warn', 'Handshake');
  else status(count ? `Ready in ${MODE_LABEL[mode]} mode.` : 'Ready. Enroll a passkey to start.', 'ok', 'Ready');
}
init().catch(e => { setTag($('net'), 'Offline', 'bad'); status(reason(e), 'bad'); });
