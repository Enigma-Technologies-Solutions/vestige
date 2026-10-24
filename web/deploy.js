'use strict';
// Deploys the Vestige build in /deploy-bundle.json through Arachnid's CREATE2 factory on each chain. The wallet only
// signs; every read (checks, estimates, confirmation) goes to the chain's public RPC directly.
const $ = id => document.getElementById(id);
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const short = h => h ? h.slice(0, 10) + '…' + h.slice(-6) : '—';
const word = n => ethers.zeroPadValue(ethers.toBeHex(n), 32);

const PARAMS = new URLSearchParams(location.search);
const CHAINS = [
  { id: 11155111, name: 'Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', native: 'ETH', testnet: true },
  { id: 84532, name: 'Base Sepolia', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', native: 'ETH', testnet: true },
  { id: 10143, name: 'Monad testnet', rpc: 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadscan.com', native: 'MON', testnet: true },
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', native: 'ETH', testnet: false },
  { id: 8453, name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', native: 'ETH', testnet: false },
  { id: 143, name: 'Monad', rpc: 'https://rpc.monad.xyz', explorer: 'https://monadscan.com', native: 'MON', testnet: false },
];
// ?local=1 adds the lab's Hardhat node (needs the factory installed there; see README).
if (PARAMS.get('local') === '1') CHAINS.unshift({ id: 31337, name: 'Hardhat local', rpc: 'http://127.0.0.1:8545', native: 'ETH', testnet: true, local: true });
const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';

// Arachnid deterministic-deployment-proxy runtime, as deployed on Ethereum mainnet.
const FACTORY_CODEHASH = '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989';
const HISTORY = '0x0000F90827F1C53a10cb7A02335B175320002935';
// A valid P-256 (hash ‖ r ‖ s ‖ x ‖ y) for the 0x100 precompile; the bad copy flips one bit of r.
const P256_OK = '0xfd0aefc38daec661951c8031c3971e71af7f02bd29cdb4b2b60698fdf8e245bab201eb8520ed47600ee7edf2a5f33d35bca3d83651b9804cf533ce314c7b42114b8a7386279097c20de00520f9c397b173849765ae11f713812bac86e63f7a7d25959e828ab0b19fc1da12f0d47f04484d42831071335c2a145f8509868651c66b4c01bc5a11454ac498c942cc6b325629b7ce9a752cb4bf625fa0757f74732a';
const P256_BAD = (() => { const b = ethers.getBytes(P256_OK); b[63] ^= 1; return ethers.hexlify(b); })();
// Init code run via eth_call: returns (NUMBER - 1, BLOCKHASH(NUMBER - 1)).
const BLOCKHASH_PROBE = '0x4360019003804060205260005260406000f3';
// Init code deploying a 1-byte STOP contract: the factory's eth_call result must equal the EVM CREATE2 address.
const CREATE2_PROBE = '0x600160008160098239f300';
const CREATE2_SALT = ethers.id('vestige-probe-salt');

// Reown project id for this deploy tool. Public by design: every dapp ships its id in client code.
const DEFAULT_PROJECT_ID = 'b6e2a9dea4c173bca01c645f4a241a16';
const PROJECT = 'vestige-deploy-wc-project', EXPECTED = 'vestige-deploy-expected', MAINNETS = 'vestige-deploy-mainnets';
const BURNER = 'vestige-deploy-test-wallet-key';
const MANIFEST = 'vestige-deploy-manifest-v1', JOURNAL = 'vestige-deploy-journal-v1';
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};

let B = null, wallet = null, wc = null, deploying = false, identity = { ok: false, detail: 'Not checked' };
const mainnet = new ethers.JsonRpcProvider(MAINNET_RPC, 1, { staticNetwork: true, batchMaxCount: 1 });
const nets = CHAINS.map(chain => ({
  chain,
  rpc: new ethers.JsonRpcProvider(chain.rpc, chain.id, { staticNetwork: true, batchMaxCount: 1, pollingInterval: 2000 }),
  checks: [], state: 'idle', note: '', account: null, tx: null,
}));
const session = crypto.randomUUID();
let journal = store.json(JOURNAL, []);
const manifest = store.json(MANIFEST, {});

// ---- journal ----
function record(type, data = {}) {
  journal.push(JSON.parse(JSON.stringify({ at: new Date().toISOString(), session, type, ...data }, (k, v) => typeof v === 'bigint' ? v.toString() : v)));
  journal = journal.slice(-500);
  store.set(JOURNAL, JSON.stringify(journal));
  renderJournal();
}
const SUMMARY = e => e.text ?? [e.chain, e.hash && short(e.hash), e.account && short(e.account), e.error].filter(Boolean).join(' · ');
function renderJournal() {
  const items = journal.slice(-60).reverse().map(e => {
    const li = document.createElement('li'), at = document.createElement('span'), what = document.createElement('span'), st = document.createElement('span');
    at.className = 'log__time'; at.textContent = new Date(e.at).toLocaleTimeString();
    what.className = 'log__what'; what.textContent = e.type;
    st.className = 'st' + (/error|fail|reject/i.test(e.type) ? ' st--bad' : /ok|deployed|connected/i.test(e.type) ? ' st--ok' : '');
    st.textContent = SUMMARY(e) || '—'; st.title = st.textContent;
    li.append(at, what, st);
    return li;
  });
  if (!items.length) { const li = document.createElement('li'); li.className = 'log__empty'; li.textContent = 'Nothing yet.'; items.push(li); }
  $('journal').replaceChildren(...items);
}

function setTag(el, text, kind) { el.textContent = text; el.className = 'st' + (kind ? ' st--' + kind : ''); }
function status(text, kind = '', tag) {
  $('statusText').textContent = text;
  setTag($('statusTag'), tag || { ok: 'OK', bad: 'Error', warn: 'Waiting' }[kind] || 'Info', kind);
  $('status').className = 'status' + (kind === 'bad' ? ' status--bad' : '');
}
function reason(e) {
  if (e?.code === 4001 || e?.info?.error?.code === 4001 || /user rejected|rejected the request/i.test(e?.message)) return 'Rejected in the wallet';
  return e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
}

// ---- build bundle ----
async function loadBuild() {
  const res = await fetch('/deploy-bundle.json', { cache: 'no-store' });
  check(res.ok, 'No deploy bundle. Run npm run deploy:build, then reload.');
  B = await res.json();
  const initHash = ethers.keccak256(B.initcode);
  const predicted = ethers.getCreate2Address(B.factory, B.salt, initHash);
  const facts = [
    ['Contract', B.contract],
    ['Compiler', `solc ${B.compiler} · optimizer ${B.settings.optimizer.enabled ? 'on, ' + B.settings.optimizer.runs + ' runs' : 'off'} · ${B.settings.evmVersion}`],
    ['Factory', `${B.factory} (Arachnid deterministic-deployment-proxy)`],
    ['Salt', B.salt],
    ['Init code', `${ethers.dataLength(B.initcode)} bytes · keccak256 ${initHash}`],
    ['Runtime', `${ethers.dataLength(B.runtimeBytecode)} bytes · keccak256 ${ethers.keccak256(B.runtimeBytecode)}`],
    ['Address', predicted],
  ];
  const ok = initHash === B.initcodeHash && predicted === B.address && ethers.keccak256(B.runtimeBytecode) === B.runtimeHash
    && ethers.getAddress(B.factory) === '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  // The lab's source bundle, when present, must describe the same runtime code.
  try {
    const src = await (await fetch('/contract-source.json', { cache: 'no-store' })).json();
    facts.push(['Lab source', src.runtimeBytecode === B.runtimeBytecode ? 'Same runtime code as the verified source in the lab' : 'Differs from the lab source bundle: rebuild both']);
  } catch {}
  $('buildFacts').replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v; if (k === 'Address') dd.className = 'hl';
    return [dt, dd];
  }));
  setTag($('buildTag'), ok ? 'Address recomputed' : 'Mismatch', ok ? 'ok' : 'bad');
  check(ok, 'The deploy bundle is inconsistent (address or hashes do not recompute). Rebuild it.');
  record('build.ok', { address: B.address, initcodeHash: B.initcodeHash, compiler: B.compiler });
}

// ---- chain checks ----
async function probe(net) {
  const { rpc, chain } = net;
  const checks = [];
  const add = (key, ok, title, detail, required = true) => checks.push({ key, ok, title, detail, required });
  net.state = 'checking'; net.checks = []; renderNets();
  try {
    const id = Number(await rpc.send('eth_chainId', []));
    add('chain', id === chain.id, 'RPC serves this chain', `eth_chainId ${id}`);

    const ok = await rpc.send('eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: P256_OK }, 'latest']).catch(() => '0x');
    const bad = await rpc.send('eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: P256_BAD }, 'latest']).catch(() => '0x');
    add('p256', ok !== '0x' && BigInt(ok) === 1n && (bad === '0x' || BigInt(bad) === 0n), 'P-256 precompile', 'valid signature → 1, tampered → empty');

    const head = await rpc.getBlock('latest');
    const ret = await rpc.send('eth_call', [{ data: BLOCKHASH_PROBE }, ethers.toQuantity(head.number)]);
    const n = Number(BigInt(ethers.dataSlice(ret, 0, 32))), evmHash = ethers.dataSlice(ret, 32, 64);
    const real = await rpc.getBlock(n);
    add('blockhash', real && real.hash === evmHash, 'Honest blockhash', `EVM hash of #${n} ${real && real.hash === evmHash ? 'equals' : 'differs from'} the block's hash`);

    const histCode = await rpc.getCode(HISTORY);
    let histOk = false, histDetail = 'no history contract';
    if (histCode !== '0x') {
      const back = head.number > 4001 ? 4000 : Math.max(1, head.number - 1);
      const m = head.number - back;
      const got = await rpc.send('eth_call', [{ to: HISTORY, data: word(m) }, 'latest']).catch(() => null);
      histOk = got === (await rpc.getBlock(m)).hash;
      histDetail = histOk ? `served #${m}, ${back} blocks back` : 'present but did not serve history';
    }
    add('history', histOk, 'EIP-2935 history', histDetail + ' · needed only for windows above 256 blocks', false);

    const factoryCode = await rpc.getCode(B.factory);
    add('factory', factoryCode !== '0x' && ethers.keccak256(factoryCode) === FACTORY_CODEHASH, 'CREATE2 factory', factoryCode === '0x' ? 'not deployed on this chain' : `code hash ${short(ethers.keccak256(factoryCode))}`);

    const expect = ethers.getCreate2Address(B.factory, CREATE2_SALT, ethers.keccak256(CREATE2_PROBE)).toLowerCase();
    const out = factoryCode === '0x' ? '0x' : await rpc.send('eth_call', [{ to: B.factory, data: ethers.concat([CREATE2_SALT, CREATE2_PROBE]) }, 'latest']).catch(() => '0x');
    add('create2', out.length >= 42 && ('0x' + out.slice(-40)).toLowerCase() === expect, 'EVM CREATE2 derivation', 'factory dry-run lands where keccak256(0xff ‖ factory ‖ salt ‖ hash) says');

    net.checks = checks;
    await readDeployment(net);
    if (wallet) await readAccount(net);
    record('check', { chain: chain.name, text: `${chain.name}: ${checks.filter(c => c.ok).length}/${checks.length} checks pass · ${net.state}` });
  } catch (e) {
    net.checks = checks;
    net.state = 'error'; net.note = reason(e);
    record('check.error', { chain: chain.name, error: reason(e) });
  }
  renderNets();
}

async function readDeployment(net) {
  const code = await net.rpc.getCode(B.address);
  const ready = net.checks.filter(c => c.required).every(c => c.ok);
  if (code === B.runtimeBytecode) {
    net.state = 'deployed'; net.note = 'Code at the address equals the build';
    const m = manifest[net.chain.id];
    if (!m) { manifest[net.chain.id] = { name: net.chain.name, tx: null, block: null, deployer: null, verifiedAt: new Date().toISOString() }; saveManifest(); }
  } else if (code !== '0x') {
    net.state = 'mismatch'; net.note = `Different code (${ethers.dataLength(code)} bytes) at the address`;
  } else if (await net.rpc.getTransactionCount(B.address) > 0) {
    // CREATE2 refuses an address with a nonce, even with no code there.
    net.state = 'blocked'; net.note = 'The address has a nonce but no code; CREATE2 there would fail';
  } else {
    net.state = ready ? 'ready' : 'blocked';
    net.note = ready ? 'Nothing at the address yet' : 'A required check failed';
  }
}

async function readAccount(net) {
  // Reads overlap (connect, re-check, deploy); only the latest may write, so a balance read before funding never wins.
  const seq = net.accountSeq = (net.accountSeq ?? 0) + 1;
  net.account = null;
  if (!wallet || net.state !== 'ready') return;
  const from = wallet.account, { rpc } = net;
  // Raw eth_getBalance: ethers' getBalance() was seen returning a pre-funding 0 at a block where the node reported the funds.
  const [code, balance, fee] = await Promise.all([rpc.getCode(from), rpc.send('eth_getBalance', [from, 'latest']).then(BigInt), rpc.getFeeData()]);
  let gas = null, gasError = null;
  try { gas = BigInt(await rpc.send('eth_estimateGas', [{ from, to: B.factory, data: ethers.concat([B.salt, B.initcode]) }])); }
  catch (e) { gasError = reason(e); }
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  // 0xef0100 ‖ address is an EIP-7702 delegation: still an EOA that sends ordinary transactions.
  const delegate = code.startsWith('0xef0100') && ethers.dataLength(code) === 23 ? ethers.getAddress(ethers.dataSlice(code, 3)) : null;
  if (seq !== net.accountSeq) return;
  net.account = { smart: code !== '0x' && !delegate, delegate, balance, gas, gasError, cost: gas ? gas * price : null };
}

// ---- wallet ----
function adoptWallet(provider, via, account) {
  wallet = { provider, via, account: ethers.getAddress(account) };
  record('wallet.connected', { text: `${via} · ${wallet.account}` });
  renderWallet();
  checkIdentity();
  nets.forEach(n => readAccount(n).then(renderNets).catch(() => {}));
  status(`Connected ${short(wallet.account)} via ${via}. Pick a network below.`, 'ok', 'Connected');
}

async function connectWalletConnect() {
  const projectId = $('projectId').value.trim();
  check(/^[0-9a-f]{32}$/i.test(projectId), 'Enter a WalletConnect project id (32 hex characters) from dashboard.reown.com');
  check(window.VestigeWallet, 'The WalletConnect bundle did not load. Run npm run deploy:build.');
  store.set(PROJECT, projectId);
  wc = await initWc(projectId);
  if (!wc.session) {
    status('Opening a WalletConnect session…', 'warn', 'Pairing');
    // The SDK retries a refused relay connection forever; give up if no pairing code arrives.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const relay = relayError ? ` The relay answered: “${relayError}”.` : '';
        reject(new Error(`WalletConnect produced no pairing code within 20 s.${relay} Check the project id, and that ${location.origin} is allowed for it at dashboard.reown.com.`));
      }, 20000);
      onPairing = () => clearTimeout(timer);
      wc.connect().then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  $('pair').hidden = true;
  adoptWallet(wc, 'WalletConnect', wc.accounts[0]);
}

async function initWc(projectId) {
  const { EthereumProvider } = window.VestigeWallet;
  const remote = CHAINS.filter(c => !c.local);
  const p = await EthereumProvider.init({
    projectId,
    showQrModal: false,
    optionalChains: remote.map(c => c.id),
    rpcMap: Object.fromEntries(remote.map(c => [c.id, c.rpc])),
    metadata: { name: 'Vestige Deploy', description: 'Deterministic deployment of Vestige.sol', url: location.origin, icons: [location.origin + '/assets/favicon.svg'] },
  });
  p.on('display_uri', showPairing);
  p.signer?.client?.core?.relayer?.on?.('relayer_error', e => { relayError = e?.message ?? String(e); record('wallet.relay.error', { error: relayError }); });
  p.on('accountsChanged', a => { if (a[0] && wallet?.via === 'WalletConnect') adoptWallet(p, 'WalletConnect', a[0]); });
  p.on('chainChanged', renderWallet);
  p.on('disconnect', () => { record('wallet.disconnected', { text: 'WalletConnect session ended' }); dropWallet(); });
  return p;
}

let pairingUri = '', onPairing = null, relayError = null;
function showPairing(uri) {
  pairingUri = uri;
  onPairing?.();
  status('Scan the QR code with your wallet, or copy the pairing link into it.', 'warn', 'Pairing');
  const qr = window.VestigeWallet.qrcode(0, 'M');
  qr.addData(uri); qr.make();
  $('qr').src = qr.createDataURL(6, 2);
  $('pair').hidden = false;
  record('wallet.pairing', { text: 'Pairing QR shown' });
}

async function connectInjected() {
  check(window.ethereum, 'No browser wallet found in this browser');
  const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  window.ethereum.on?.('accountsChanged', a => a[0] ? adoptWallet(window.ethereum, 'Browser wallet', a[0]) : dropWallet());
  window.ethereum.on?.('chainChanged', renderWallet);
  adoptWallet(window.ethereum, 'Browser wallet', account);
}

// ---- test wallet ----
// A throwaway key generated in this browser for testnet deploys, so any funded account can pay for them. The key is
// kept unencrypted in localStorage; the provider below refuses to switch to or sign on anything but a testnet.
function testWalletProvider(key) {
  const signer = new ethers.Wallet(key);
  let chain = CHAINS.find(c => c.testnet);
  return {
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [signer.address];
        case 'eth_chainId': return ethers.toQuantity(chain.id);
        case 'wallet_switchEthereumChain': {
          const next = CHAINS.find(c => c.id === Number(params[0].chainId));
          if (!next?.testnet) throw new Error('The test wallet signs on testnets only');
          chain = next;
          return null;
        }
        case 'eth_sendTransaction': {
          const [tx] = params;
          check(chain.testnet, 'The test wallet signs on testnets only');
          const { rpc } = nets.find(n => n.chain.id === chain.id);
          const sent = await signer.connect(rpc).sendTransaction({ to: tx.to, data: tx.data, gasLimit: BigInt(tx.gas), chainId: chain.id });
          return sent.hash;
        }
        default: throw new Error(`The test wallet does not support ${method}`);
      }
    },
  };
}

async function connectTestWallet() {
  let key = store.get(BURNER, '');
  if (!key) {
    key = ethers.Wallet.createRandom().privateKey;
    store.set(BURNER, key);
    check(store.get(BURNER, '') === key, 'This browser does not keep localStorage, so a test wallet would be lost on reload');
    record('testwallet.created', { text: `New test wallet ${new ethers.Wallet(key).address}` });
  }
  const provider = testWalletProvider(key);
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  showTestWallet(account);
  adoptWallet(provider, 'Test wallet', account);
}

function showTestWallet(account) {
  $('twAddress').textContent = account;
  if (window.VestigeWallet) {
    const qr = window.VestigeWallet.qrcode(0, 'M');
    qr.addData(account); qr.make();
    $('twQr').src = qr.createDataURL(6, 2);
  }
  $('testWallet').hidden = false;
}

async function forgetTestWallet() {
  const key = store.get(BURNER, '');
  check(key, 'No test wallet in this browser');
  const address = new ethers.Wallet(key).address;
  const held = nets.filter(n => n.account && n.account.balance > 0n && wallet?.account === address).map(n => `${ethers.formatEther(n.account.balance)} ${n.chain.native} on ${n.chain.name}`);
  const ok = confirm(`Delete the test wallet ${address} from this browser?\n\n${held.length ? 'It still holds ' + held.join(', ') + '. ' : ''}Copy the key first if you want to keep access; deleting cannot be undone.`);
  check(ok, 'Kept the test wallet');
  try { localStorage.removeItem(BURNER); } catch {}
  if (wallet?.via === 'Test wallet') dropWallet();
  $('testWallet').hidden = true;
  record('testwallet.forgotten', { text: address });
  status('Test wallet deleted from this browser.', '', 'Idle');
}

function dropWallet() {
  wallet = null; identity = { ok: false, detail: 'Not checked' };
  nets.forEach(n => { n.account = null; });
  renderWallet(); renderNets();
}

async function disconnect() {
  if (wallet?.via === 'WalletConnect' && wc) await wc.disconnect().catch(() => {});
  record('wallet.disconnected', { text: wallet ? wallet.via : 'none' });
  dropWallet();
  status('Disconnected.', '', 'Idle');
}

async function renderWallet() {
  setTag($('walletTag'), wallet ? short(wallet.account) : 'No wallet', wallet ? 'ok' : '');
  $('via').textContent = wallet?.via ?? '—';
  $('account').textContent = wallet?.account ?? '—';
  $('ens').textContent = '—';
  $('walletChain').textContent = '—';
  $('sessionChains').textContent = '—';
  if (!wallet) return;
  const chainId = Number(await wallet.provider.request({ method: 'eth_chainId' }).catch(() => 0));
  $('walletChain').textContent = chainId ? `${CHAINS.find(c => c.id === chainId)?.name ?? 'Other'} (${chainId})` : '—';
  const approved = wallet.via === 'WalletConnect' ? wc?.session?.namespaces?.eip155?.chains?.map(c => Number(c.split(':')[1])) : null;
  $('sessionChains').textContent = approved ? approved.map(id => CHAINS.find(c => c.id === id)?.name ?? id).join(', ')
    : wallet.via === 'Test wallet' ? 'Testnets only' : 'Any (browser wallet)';
  mainnet.lookupAddress(wallet.account).then(name => { $('ens').textContent = name ?? 'No primary name'; }).catch(() => { $('ens').textContent = 'Lookup failed'; });
}

// The connected account must be the expected deployer (ENS name or address) before anything is sent.
async function checkIdentity() {
  const expected = $('expected').value.trim();
  store.set(EXPECTED, expected);
  if (!wallet) { setTag($('expectedTag'), '—'); return; }
  if (!expected) { identity = { ok: true, detail: 'No expected deployer set' }; setTag($('expectedTag'), 'Any account', 'warn'); return; }
  setTag($('expectedTag'), 'Resolving…');
  try {
    const target = ethers.isAddress(expected) ? ethers.getAddress(expected) : await mainnet.resolveName(expected);
    check(target, `${expected} does not resolve on Ethereum mainnet`);
    identity = { ok: target === wallet.account, detail: `${expected} → ${target}` };
  } catch (e) {
    identity = { ok: false, detail: reason(e) };
  }
  setTag($('expectedTag'), identity.ok ? 'Match' : 'Not this account', identity.ok ? 'ok' : 'bad');
  $('expectedTag').title = identity.detail;
  record(identity.ok ? 'identity.ok' : 'identity.fail', { text: identity.detail });
  renderNets();
}

// ---- deploy ----
async function deploy(net) {
  check(!deploying, 'Another deployment is in progress');
  check(wallet, 'Connect a wallet first');
  // Testnets take any account: the address depends only on factory, salt and code, never on the deployer.
  check(net.chain.testnet || identity.ok, `The connected account is not the expected deployer (${identity.detail})`);
  check(net.chain.testnet || wallet.via !== 'Test wallet', 'The test wallet deploys to testnets only');
  check(net.state === 'ready', `${net.chain.name} is not ready: ${net.note}`);
  deploying = true;
  const { chain } = net;
  try {
    await probe(net); // fresh state right before sending
    check(net.state === 'ready', `${chain.name} is not ready: ${net.note}`);
    check(net.account?.gas, `Gas estimate failed: ${net.account?.gasError ?? 'unknown'}`);
    check(net.account.balance >= (net.account.cost ?? 0n), `Not enough ${chain.native} on ${chain.name}: need about ${ethers.formatEther(net.account.cost)}`);
    if (!chain.testnet) {
      const ok = confirm(`Deploy Vestige to ${chain.name} (chain ${chain.id})?\n\nAddress ${B.address}\nEstimated cost ≈ ${ethers.formatEther(net.account.cost)} ${chain.native}\n\nThis is a mainnet transaction and cannot be undone.`);
      check(ok, 'Cancelled');
    }

    net.state = 'deploying'; net.note = 'Switching the wallet to ' + chain.name; renderNets();
    status(`Switch the wallet to ${chain.name}…`, 'warn', 'Wallet');
    await switchChain(chain);
    const active = Number(await wallet.provider.request({ method: 'eth_chainId' }));
    check(active === chain.id, `The wallet is on chain ${active}, not ${chain.id}`);
    renderWallet();

    const tx = { from: wallet.account, to: B.factory, data: ethers.concat([B.salt, B.initcode]), gas: ethers.toQuantity(net.account.gas * 12n / 10n) };
    record('tx.request', { chain: chain.name, text: `${chain.name}: CREATE2 via factory · gas ${tx.gas}` });
    net.note = 'Confirm the transaction in the wallet'; renderNets();
    status(`Confirm the deployment on ${chain.name} in your wallet…`, 'warn', 'Wallet');
    const hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [tx] });
    net.tx = hash;
    record('tx.sent', { chain: chain.name, hash, account: wallet.account });
    await confirmDeployment(net, hash);
  } catch (e) {
    if (net.state === 'deploying') { net.state = 'ready'; }
    net.note = reason(e);
    record('deploy.error', { chain: chain.name, error: reason(e) });
    throw e;
  } finally {
    deploying = false;
    renderNets();
  }
}

async function switchChain(chain) {
  try {
    await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ethers.toQuantity(chain.id) }] });
  } catch (e) {
    if (wallet.via === 'WalletConnect') throw new Error(`The wallet did not switch to ${chain.name}: ${reason(e)}. It must be one of the session chains; reconnect and approve it.`);
    if (e?.code !== 4902) throw e;
    await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: ethers.toQuantity(chain.id), chainName: chain.name, rpcUrls: [chain.rpc], nativeCurrency: { name: chain.native, symbol: chain.native, decimals: 18 }, blockExplorerUrls: chain.explorer ? [chain.explorer] : undefined }] });
  }
}

// Success means the build's code is at the address. The returned hash may be a smart-account operation rather than a
// transaction, so the code is what is polled; the receipt is read when the hash is a transaction on this chain.
async function confirmDeployment(net, hash) {
  const { chain, rpc } = net;
  net.note = `Sent ${short(hash)} · waiting for code at the address`; renderNets();
  status(`Sent on ${chain.name}. Waiting for the contract to appear…`, 'warn', 'Pending');
  const started = Date.now();
  while (Date.now() - started < 30 * 60 * 1000) {
    const receipt = await rpc.getTransactionReceipt(hash).catch(() => null);
    if (receipt && receipt.status === 0) throw new Error(`Transaction ${short(hash)} reverted in block ${receipt.blockNumber}`);
    const code = await rpc.getCode(B.address).catch(() => '0x');
    if (code !== '0x') {
      check(code === B.runtimeBytecode, 'Code appeared at the address but does not equal the build');
      net.state = 'deployed'; net.note = 'Code at the address equals the build';
      manifest[chain.id] = { name: chain.name, tx: hash, block: receipt?.blockNumber ?? null, deployer: wallet.account, verifiedAt: new Date().toISOString() };
      saveManifest();
      record('deployed', { chain: chain.name, hash, text: `${chain.name}: Vestige at ${B.address}` });
      status(`Deployed on ${chain.name} at ${B.address}. Code verified against the build.`, 'ok', 'Deployed');
      return;
    }
    await new Promise(r => setTimeout(r, Date.now() - started < 120000 ? 2000 : 6000));
  }
  throw new Error('No code at the address after 30 minutes. If a multisig still needs signatures, re-check later.');
}

function saveManifest() { store.set(MANIFEST, JSON.stringify(manifest)); }

// ---- rendering ----
const STATE = {
  idle: ['Not checked', ''], checking: ['Checking', ''], ready: ['Ready', 'warn'], blocked: ['Blocked', 'bad'],
  deploying: ['Deploying', 'warn'], deployed: ['Deployed', 'ok'], mismatch: ['Wrong code', 'bad'], error: ['RPC error', 'bad'],
};
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function renderNets() {
  const showMain = $('showMainnets').checked;
  $('netgrid').replaceChildren(...nets.filter(n => n.chain.testnet || showMain).map(net => {
    const { chain } = net;
    const card = el('article', 'net card'); card.dataset.chain = chain.id;
    const head = el('div', 'net__head');
    const title = el('div');
    title.append(el('h3', '', chain.name), el('span', 'fine', `chain ${chain.id} · ${chain.local ? 'local' : chain.testnet ? 'testnet' : 'mainnet'}`));
    const st = el('span'); setTag(st, ...STATE[net.state]); st.dataset.state = net.state;
    head.append(title, st);

    const checks = el('ul', 'checks');
    if (!net.checks.length) checks.append(el('li', 'log__empty', net.state === 'checking' ? 'Probing the chain…' : 'Not checked yet'));
    for (const c of net.checks) {
      const li = el('li'), tag = el('span');
      setTag(tag, c.ok ? 'Pass' : c.required ? 'Fail' : 'Warn', c.ok ? 'ok' : c.required ? 'bad' : 'warn');
      li.append(tag, el('span', '', c.title), el('span', 'checks__detail', c.detail));
      checks.append(li);
    }

    const kv = el('dl', 'kv');
    const row = (k, v) => kv.append(el('dt', '', k), el('dd', '', v));
    row('Status', net.note || '—');
    if (net.account) {
      row('Account', net.account.smart ? 'Smart account (contract): may need more signatures'
        : net.account.delegate ? `EOA with EIP-7702 delegation to ${short(net.account.delegate)}` : 'EOA');
      row('Balance', `${ethers.formatEther(net.account.balance)} ${chain.native}`);
      row('Estimate', net.account.gas ? `${net.account.gas} gas ≈ ${ethers.formatEther(net.account.cost)} ${chain.native}` : `Failed: ${net.account.gasError}`);
    }
    const m = manifest[chain.id];
    if (net.tx || m?.tx) row('Tx', net.tx || m.tx);

    const foot = el('div', 'btn-row');
    const btn = el('button', 'btn btn--volt btn--sm', net.state === 'deployed' ? 'Deployed' : `Deploy to ${chain.name}`);
    btn.type = 'button'; btn.dataset.deploy = chain.id;
    btn.disabled = deploying || net.state !== 'ready' || !wallet || !(chain.testnet || identity.ok);
    const re = el('button', 'btn btn--ghost btn--sm', 'Re-check'); re.type = 'button'; re.dataset.recheck = chain.id; re.disabled = deploying;
    foot.append(btn, re);
    if (chain.explorer && (net.state === 'deployed' || net.tx)) {
      const a = el('a', 'link fine', 'Explorer ↗');
      a.href = net.tx && !net.account?.smart ? `${chain.explorer}/tx/${net.tx}` : `${chain.explorer}/address/${B.address}`;
      a.target = '_blank'; a.rel = 'noopener';
      foot.append(a);
    }
    card.append(head, checks, kv, foot);
    return card;
  }));
}

// ---- wiring ----
async function run(fn) {
  try { await fn(); } catch (e) { status(reason(e), 'bad'); }
}
$('netgrid').onclick = e => {
  const d = e.target.closest('[data-deploy]'), r = e.target.closest('[data-recheck]');
  if (d && !d.disabled) run(() => deploy(nets.find(n => n.chain.id === Number(d.dataset.deploy))));
  if (r && !r.disabled) run(() => probe(nets.find(n => n.chain.id === Number(r.dataset.recheck))));
};
$('connectWc').onclick = () => run(connectWalletConnect);
$('connectInjected').onclick = () => run(connectInjected);
$('disconnect').onclick = () => run(disconnect);
$('connectTest').onclick = () => run(connectTestWallet);
$('twCopy').onclick = () => run(async () => { await navigator.clipboard.writeText($('twAddress').textContent); status('Test wallet address copied. Send testnet funds to it.', 'ok', 'Copied'); });
$('twKey').onclick = () => run(async () => {
  check(confirm('Copy the test wallet\'s private key to the clipboard?\n\nAnyone who sees it controls the wallet. Import it into another wallet only to recover testnet funds.'), 'Not copied');
  await navigator.clipboard.writeText(store.get(BURNER, ''));
  record('testwallet.key.copied', { text: 'Private key copied to the clipboard' });
  status('Private key copied. Clear your clipboard once you have used it.', 'warn', 'Copied');
});
$('twForget').onclick = () => run(forgetTestWallet);
$('copyUri').onclick = () => run(async () => { await navigator.clipboard.writeText(pairingUri); status('Pairing link copied. Paste it into the wallet.', 'ok', 'Copied'); });
$('expected').onchange = () => run(checkIdentity);
$('showMainnets').onchange = () => { store.set(MAINNETS, $('showMainnets').checked ? '1' : '0'); renderNets(); };
$('recheck').onclick = () => run(() => Promise.all(nets.map(probe)));
$('downloadManifest').onclick = () => download(`vestige-deployments.json`, {
  contract: B?.contract, compiler: B?.compiler, settings: B?.settings, address: B?.address, factory: B?.factory, salt: B?.salt,
  initcodeHash: B?.initcodeHash, runtimeHash: B?.runtimeHash,
  deployments: Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a - b)),
});
$('downloadLog').onclick = () => download(`vestige-deploy-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, {
  format: 'vestige-deploy-log/1', exportedAt: new Date().toISOString(), origin: location.origin, userAgent: navigator.userAgent,
  build: B && { address: B.address, initcodeHash: B.initcodeHash, runtimeHash: B.runtimeHash, compiler: B.compiler },
  wallet: wallet && { via: wallet.via, account: wallet.account }, identity,
  networks: nets.map(n => ({ chain: n.chain, state: n.state, note: n.note, checks: n.checks, tx: n.tx })),
  manifest, journal,
});
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function effectiveTheme() { return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function renderThemeButton() { $('theme').textContent = effectiveTheme() === 'dark' ? 'Light' : 'Dark'; }
$('theme').onclick = () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('vestige-theme', next);
  renderThemeButton();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);

async function init() {
  renderThemeButton();
  renderJournal();
  $('projectId').value = store.get(PROJECT, DEFAULT_PROJECT_ID);
  $('expected').value = store.get(EXPECTED, 'jjpa.eth');
  $('showMainnets').checked = store.get(MAINNETS, '0') === '1';
  check(window.isSecureContext, 'Open this page at http://localhost or over HTTPS.');
  renderNets();
  const twKey = store.get(BURNER, '');
  if (twKey) showTestWallet(new ethers.Wallet(twKey).address);
  await loadBuild();
  status(`Vestige goes to ${B.address} on every chain. Checking networks…`, 'warn', 'Checking');
  await Promise.all(nets.map(probe));
  status(`Vestige goes to ${B.address} on every chain. Connect the deployer to continue.`, '', 'Ready');
  // Resume a WalletConnect session kept from an earlier visit.
  const projectId = store.get(PROJECT, '');
  if (projectId && window.VestigeWallet) {
    try { wc = await initWc(projectId); if (wc.session && wc.accounts[0]) adoptWallet(wc, 'WalletConnect', wc.accounts[0]); }
    catch (e) { record('wallet.resume.error', { error: reason(e) }); }
  }
}
run(init);
