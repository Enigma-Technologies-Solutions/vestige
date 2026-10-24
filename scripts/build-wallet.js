// Bundles the WalletConnect EIP-1193 provider and a QR encoder into web/vendor/wallet.js for web/deploy.html.
// The page draws its own QR from `display_uri`, so Reown's AppKit modal (a dynamic import) is never loaded.
// Usage: node scripts/build-wallet.js
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const out = path.join(root, "web", "vendor", "wallet.js");

esbuild
  .build({
    stdin: {
      contents: `
        import { EthereumProvider } from "@walletconnect/ethereum-provider";
        import qrcode from "qrcode-generator";
        window.VestigeWallet = { EthereumProvider, qrcode };
      `,
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    external: ["@reown/appkit/core"],
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    legalComments: "linked",
    outfile: out,
    logLevel: "warning",
  })
  .then(() => console.log(`Wrote ${path.relative(process.cwd(), out)}`))
  .catch(() => (process.exitCode = 1));
