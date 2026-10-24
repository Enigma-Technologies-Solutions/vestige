// Publishes Vestige's source on Sourcify and Etherscan for one chain, after checking that the code at the CREATE2
// address is exactly this build. Results accumulate in verification.json, one entry per chain.
// Usage: npm run verify -- --network sepolia   (networks: see hardhat.config.js)
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const CONTRACT = "contracts/Vestige.sol:Vestige";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = "0x" + "00".repeat(32);
const OUT = path.join(__dirname, "..", "verification.json");

async function sourcifyStatus(chainId, address) {
  const res = await fetch(`${hre.config.sourcify.apiUrl}/v2/contract/${chainId}/${address}`);
  if (res.status === 404) return "none";
  if (!res.ok) return `HTTP ${res.status}`;
  const body = await res.json();
  return body.match ?? "none"; // "exact_match" (metadata hash too) or "match"
}

async function etherscanStatus(chainId, address) {
  const url = new URL("https://api.etherscan.io/v2/api");
  for (const [k, v] of Object.entries({ chainid: chainId, module: "contract", action: "getsourcecode", address, apikey: hre.config.etherscan.apiKey }))
    url.searchParams.set(k, v);
  const body = await (await fetch(url)).json();
  if (body.status !== "1") return `error: ${body.result ?? body.message}`;
  return body.result[0]?.SourceCode ? "verified" : "none";
}

// Sourcify's v2 API, called directly: hardhat-verify 2.1.3 still posts to the older endpoint, which now refuses.
async function submitSourcify(chainId, address) {
  const buildInfo = await hre.artifacts.getBuildInfo(CONTRACT);
  const api = hre.config.sourcify.apiUrl;
  const res = await fetch(`${api}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput: buildInfo.input, compilerVersion: buildInfo.solcLongVersion, contractIdentifier: CONTRACT }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return "already verified";
  if (!res.ok) return `failed: HTTP ${res.status} ${body.message ?? ""}`.trim();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const job = await (await fetch(`${api}/v2/verify/${body.verificationId}`)).json();
    if (!job.isJobCompleted) continue;
    if (job.error) return `failed: ${job.error.message ?? job.error.customCode}`;
    console.log(`Sourcify: ${job.contract.match} (runtime ${job.contract.runtimeMatch}, creation ${job.contract.creationMatch})`);
    return "submitted";
  }
  return `failed: job ${body.verificationId} still running after 2 minutes`;
}

// Each provider is attempted independently: one failing (no key, unsupported plan) must not skip the other.
async function attempt(task, args) {
  try {
    await hre.run(task, args);
    return "submitted";
  } catch (err) {
    return `failed: ${err.message.split("\n")[0]}`;
  }
}

async function main() {
  const { ethers, network, artifacts } = hre;
  if (network.name === "hardhat" || network.name === "localhost") throw new Error("Pick a public network: --network sepolia | baseSepolia | monadTestnet | mainnet | base | monad");

  const [file, name] = CONTRACT.split(":");
  const output = (await artifacts.getBuildInfo(CONTRACT)).output.contracts[file][name];
  const initcode = "0x" + output.evm.bytecode.object;
  const runtime = "0x" + output.evm.deployedBytecode.object;
  const address = ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(initcode));
  const { chainId } = await ethers.provider.getNetwork();

  console.log(`${network.name} (chain ${chainId}) · Vestige at ${address}`);
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error("Nothing deployed at the address on this chain yet. Deploy it from web/deploy.html first.");
  if (code.toLowerCase() !== runtime.toLowerCase())
    throw new Error("The code at the address differs from this build. Was the contract recompiled after deploying? Verify from the commit that was deployed.");
  console.log("Code at the address equals this build.\n");

  const args = { address, contract: CONTRACT };
  console.log("— Sourcify");
  const sourcify = await submitSourcify(chainId, address).catch((err) => `failed: ${err.message}`);
  console.log("\n— Etherscan");
  const etherscan = hre.config.etherscan.apiKey
    ? await attempt("verify:etherscan", { ...args, constructorArgsParams: [] })
    : "skipped: API_ETHERSCAN_KEY not set";

  const entry = {
    network: network.name,
    address,
    runtimeHash: ethers.keccak256(runtime),
    checkedAt: new Date().toISOString(),
    sourcify: { attempt: sourcify, status: await sourcifyStatus(chainId, address) },
    etherscan: { attempt: etherscan, status: hre.config.etherscan.apiKey ? await etherscanStatus(chainId, address) : "unknown" },
  };
  const all = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  all[chainId] = entry;
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");

  console.log(`\nSourcify: ${entry.sourcify.status} (${sourcify})`);
  console.log(`Etherscan: ${entry.etherscan.status} (${etherscan})`);
  console.log(`Recorded in ${path.relative(process.cwd(), OUT)}`);
  if (entry.sourcify.status === "none" && entry.etherscan.status !== "verified") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
