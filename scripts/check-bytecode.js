#!/usr/bin/env node
// Fails if the compiled runtime code differs from what is deployed. The CREATE2 address commits to the bytecode, so
// any change to Vestige.sol, its imports or the compiler settings would put a fresh build at a different address
// than the one in verification.json. Run after `hardhat compile`.
//
//   npm run check:bytecode

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { keccak256 } = require("ethers");

const repo = join(__dirname, "..");
const artifact = JSON.parse(readFileSync(join(repo, "artifacts/contracts/Vestige.sol/Vestige.json"), "utf8"));
const deployed = JSON.parse(readFileSync(join(repo, "verification.json"), "utf8"));

const built = keccak256(artifact.deployedBytecode);
let bad = 0;
for (const [chainId, { network, runtimeHash }] of Object.entries(deployed)) {
  const ok = runtimeHash === built;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} ${network} (${chainId}) ${runtimeHash}`);
}
if (bad) {
  console.error(`\nThis build's runtime hash is ${built}. It no longer matches ${bad} deployment(s).`);
  process.exit(1);
}
console.log(`\nBuild matches every deployment (${built}).`);
