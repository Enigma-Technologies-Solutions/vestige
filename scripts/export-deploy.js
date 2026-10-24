// Writes web/deploy-bundle.json: the exact creation code web/deploy.html sends through the CREATE2 factory, the
// runtime code it expects at the predicted address, and the build facts behind both.
// Usage: npx hardhat run scripts/export-deploy.js
const fs = require("node:fs");
const path = require("node:path");

const CONTRACT = "contracts/Vestige.sol:Vestige";
const OUT = path.join(__dirname, "..", "web", "deploy-bundle.json");
// Arachnid's deterministic-deployment-proxy: calldata is salt ‖ initcode, CREATE2 from the factory's address.
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
// Plain salt: anyone can reproduce the address, and redeploying it elsewhere can only ever place this exact code.
const SALT = "0x" + "00".repeat(32);

async function writeDeployBundle(artifacts, ethers) {
  const [file, name] = CONTRACT.split(":");
  const buildInfo = await artifacts.getBuildInfo(CONTRACT);
  const output = buildInfo.output.contracts[file][name];
  const constructor = output.abi.find((f) => f.type === "constructor");
  if (constructor?.inputs.length) throw new Error("Vestige must have no constructor arguments for one address on every chain");
  if (Object.keys(output.evm.deployedBytecode.immutableReferences ?? {}).length) throw new Error("Vestige must have no immutables");

  const initcode = "0x" + output.evm.bytecode.object;
  const bundle = {
    contract: CONTRACT,
    compiler: buildInfo.solcLongVersion,
    settings: { optimizer: buildInfo.input.settings.optimizer, evmVersion: buildInfo.input.settings.evmVersion },
    factory: FACTORY,
    salt: SALT,
    initcode,
    initcodeHash: ethers.keccak256(initcode),
    runtimeBytecode: "0x" + output.evm.deployedBytecode.object,
    runtimeHash: ethers.keccak256("0x" + output.evm.deployedBytecode.object),
    address: ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(initcode)),
    // The lab reads this to talk to the deployed contract on public testnets.
    abi: output.abi,
  };
  fs.writeFileSync(OUT, JSON.stringify(bundle, null, 2));
  return { out: OUT, address: bundle.address };
}

module.exports = { writeDeployBundle };

if (require.main === module) {
  const { artifacts, ethers } = require("hardhat");
  writeDeployBundle(artifacts, ethers)
    .then(({ out, address }) => console.log(`Wrote ${path.relative(process.cwd(), out)} · Vestige at ${address} on every chain`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
