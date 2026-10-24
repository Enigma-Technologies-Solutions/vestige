// Deploys Vestige to a running node and writes web/deployment.json for the browser client.
// Usage: npx hardhat run scripts/deploy.js --network localhost
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, artifacts } = require("hardhat");
const { writeSourceBundle } = require("./export-source");

const BLOCK_INTERVAL_MS = Number(process.env.VESTIGE_BLOCK_INTERVAL_MS ?? 2000);

async function main() {
  const vestige = await ethers.deployContract("Vestige");
  await vestige.waitForDeployment();

  // A local node only mines on transactions by default; a ticking chain makes block anchors meaningful.
  if (network.name === "localhost" && BLOCK_INTERVAL_MS > 0) {
    await network.provider.send("evm_setIntervalMining", [BLOCK_INTERVAL_MS]);
  }

  const { chainId } = await ethers.provider.getNetwork();
  const deployment = {
    address: await vestige.getAddress(),
    chainId: Number(chainId),
    deployBlock: (await vestige.deploymentTransaction().wait()).blockNumber,
    blockIntervalMs: BLOCK_INTERVAL_MS,
    abi: (await artifacts.readArtifact("Vestige")).abi,
  };
  const out = path.join(__dirname, "..", "web", "deployment.json");
  fs.writeFileSync(out, JSON.stringify(deployment, null, 2));
  console.log(`Vestige ${deployment.address} on chain ${deployment.chainId}`);
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
  console.log(`Wrote ${path.relative(process.cwd(), await writeSourceBundle(artifacts))}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
