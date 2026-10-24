require("@nomicfoundation/hardhat-toolbox");

// API_ETHERSCAN_KEY (one Etherscan V2 key covers every chain below) may live in an untracked .env.
try { process.loadEnvFile(); } catch {}

// Osaka (the default) ships P-256 verification natively (EIP-7951). P256_PRECOMPILE=0 pins Prague with
// RIP-7212 disabled so the tests exercise OpenZeppelin's pure-Solidity fallback instead.
const nativeP256 = process.env.P256_PRECOMPILE !== "0";

// Read-only public RPCs, the same ones web/deploy.js uses. No accounts: deploying happens in the browser wallet;
// these networks exist so scripts/verify.js can read the chain and submit source code.
const remote = (url) => ({ url, accounts: [] });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: nativeP256 ? {} : { hardfork: "prague", enableRip7212: false },
    sepolia: remote("https://ethereum-sepolia-rpc.publicnode.com"),
    baseSepolia: remote("https://sepolia.base.org"),
    monadTestnet: remote("https://testnet-rpc.monad.xyz"),
    mainnet: remote("https://ethereum-rpc.publicnode.com"),
    base: remote("https://mainnet.base.org"),
    monad: remote("https://rpc.monad.xyz"),
  },
  // A single string key selects Etherscan's V2 API, which serves every chain id from api.etherscan.io.
  etherscan: {
    apiKey: process.env.API_ETHERSCAN_KEY ?? "",
    customChains: [
      { network: "monad", chainId: 143, urls: { apiURL: "https://api.etherscan.io/v2/api", browserURL: "https://monadscan.com" } },
      { network: "monadTestnet", chainId: 10143, urls: { apiURL: "https://api.etherscan.io/v2/api", browserURL: "https://testnet.monadscan.com" } },
    ],
  },
  sourcify: { enabled: true },
};
