// Writes web/contract-source.json: the exact sources, compiler settings, metadata and runtime bytecode behind
// the Vestige artifact, so the lab can show the source and check it against the deployed code.
// Usage: npx hardhat run scripts/export-source.js   (deploy.js also calls it)
const fs = require("node:fs");
const path = require("node:path");

const CONTRACT = "contracts/Vestige.sol:Vestige";
const OUT = path.join(__dirname, "..", "web", "contract-source.json");

// AST ids of state variables, so immutable references can be shown by name.
function variableNames(ast) {
  const names = {};
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration" && node.stateVariable) names[node.id] = node.name;
    Object.values(node).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v)));
  };
  walk(ast);
  return names;
}

async function writeSourceBundle(artifacts) {
  const [file, name] = CONTRACT.split(":");
  const buildInfo = await artifacts.getBuildInfo(CONTRACT);
  const output = buildInfo.output.contracts[file][name];
  const names = variableNames(buildInfo.output.sources[file].ast);
  const ozPackage = require.resolve("@openzeppelin/contracts/package.json", { paths: [path.join(__dirname, "..")] });

  const bundle = {
    contract: CONTRACT,
    compiler: buildInfo.solcLongVersion,
    settings: { optimizer: buildInfo.input.settings.optimizer, evmVersion: buildInfo.input.settings.evmVersion },
    packages: { "@openzeppelin/contracts": JSON.parse(fs.readFileSync(ozPackage, "utf8")).version },
    metadata: output.metadata,
    runtimeBytecode: "0x" + output.evm.deployedBytecode.object,
    constructorInputs: (output.abi.find((f) => f.type === "constructor")?.inputs ?? []).length,
    immutables: Object.entries(output.evm.deployedBytecode.immutableReferences).map(([id, refs]) => ({ name: names[id] ?? `#${id}`, refs })),
    // Vestige.sol first, then its imports in path order.
    sources: Object.fromEntries(
      Object.entries(buildInfo.input.sources)
        .sort(([a], [b]) => (a === file ? -1 : b === file ? 1 : a.localeCompare(b)))
        .map(([p, s]) => [p, s.content]),
    ),
  };
  fs.writeFileSync(OUT, JSON.stringify(bundle));
  return OUT;
}

module.exports = { writeSourceBundle };

if (require.main === module) {
  const { artifacts } = require("hardhat");
  writeSourceBundle(artifacts)
    .then((out) => console.log(`Wrote ${path.relative(process.cwd(), out)}`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
