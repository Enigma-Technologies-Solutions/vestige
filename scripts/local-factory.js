// Installs Arachnid's CREATE2 factory on the local Hardhat node, so deploy.html?local=1 can rehearse a deployment.
// Public chains already have it at the same address. Usage: npx hardhat run scripts/local-factory.js --network localhost
const { network } = require("hardhat");

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
// Runtime code as deployed on Ethereum mainnet (keccak256 0x2fa86add…7e4989, checked by deploy.html).
const CODE = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

network.provider
  .send("hardhat_setCode", [FACTORY, CODE])
  .then(() => console.log(`Installed the CREATE2 factory at ${FACTORY} on ${network.name}`))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
