// Testnet relayer for the lab, served by scripts/serve.js. It signs cosign() with a key from the environment or the
// untracked .env (LAB_RELAYER_KEY, else SEPOLIA_ETH_KEY), so the key never reaches the browser. It only sends
// cosign() to the Vestige deployment on the testnets below, and only for requests from the lab page itself.
const path = require("node:path");
const { ethers } = require("ethers");

const CHAINS = {
  84532: "https://sepolia.base.org",
  10143: "https://testnet-rpc.monad.xyz",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
};
const MAX_BODY = 32 * 1024;

function createRelay(origin) {
  try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch {}
  const key = process.env.LAB_RELAYER_KEY || process.env.SEPOLIA_ETH_KEY;
  if (!key) return null;
  const signer = new ethers.Wallet(key);
  const bundle = require(path.join(__dirname, "..", "web", "deploy-bundle.json"));
  const cosign = new ethers.Interface(bundle.abi).getFunction("cosign");
  const providers = {};
  const providerFor = (chainId) =>
    (providers[chainId] ??= new ethers.JsonRpcProvider(CHAINS[chainId], chainId, { staticNetwork: true, batchMaxCount: 1 }));
  let queue = Promise.resolve(); // one transaction at a time keeps nonces in order

  async function send({ chainId, data }) {
    if (!CHAINS[chainId]) throw Object.assign(new Error(`Chain ${chainId} is not a relayed testnet`), { status: 400 });
    if (typeof data !== "string" || !data.startsWith(cosign.selector)) throw Object.assign(new Error("Only cosign() calls are relayed"), { status: 400 });
    const provider = providerFor(chainId), wallet = signer.connect(provider);
    const tx = { to: bundle.address, data };
    let gas;
    try {
      gas = await provider.estimateGas({ ...tx, from: wallet.address });
    } catch (err) {
      // A revert: hand the data back so the page decodes the contract's error itself.
      throw Object.assign(new Error(err.shortMessage ?? err.message), { status: 422, revert: err.data ?? err.info?.error?.data });
    }
    // Monad charges for the gas limit, not the gas used, so keep the margin small.
    const sent = await wallet.sendTransaction({ ...tx, gasLimit: (gas * 11n) / 10n });
    return { hash: sent.hash };
  }

  return {
    address: signer.address,
    async handle(req, res) {
      const reply = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET") return reply(200, { address: signer.address, chains: Object.keys(CHAINS).map(Number) });
      // Only the lab page may ask: other sites in this browser could otherwise spend the relayer's testnet gas.
      if (req.method !== "POST" || req.headers.origin !== origin || !req.headers["content-type"]?.startsWith("application/json"))
        return reply(403, { error: "Forbidden" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return reply(413, { error: "Too large" });
      }
      try {
        const request = JSON.parse(body);
        const result = await (queue = queue.then(() => send(request), () => send(request)));
        reply(200, result);
      } catch (err) {
        reply(err.status ?? 500, { error: err.shortMessage ?? err.message, revert: err.revert });
      }
    },
  };
}

module.exports = { createRelay };
