// Checks that API_ETHERSCAN_KEY works with Etherscan's V2 API on every chain scripts/verify.js targets.
// The key is read from the environment (or an untracked .env) and never printed.
// Usage: npm run verify:key
try { process.loadEnvFile(); } catch {}

const API = "https://api.etherscan.io/v2/api";
const CHAINS = [
  [11155111, "Sepolia"],
  [84532, "Base Sepolia"],
  [10143, "Monad testnet"],
  [1, "Ethereum"],
  [8453, "Base"],
  [143, "Monad"],
];
// Vestige's CREATE2 address: the same lookup scripts/verify.js makes before submitting.
const VESTIGE = "0xc5b8A9e7175c102d51116249F121A65079224b6f";
// Free keys allow a few calls per second.
const PACE_MS = 450;
// Well-formed (50 characters) but never issued: Etherscan looks it up instead of rejecting its shape.
const GUID = "vestigekeycheck".padEnd(50, "0");
// Verdicts from harmless to fatal; the summary reports the worst one seen.
const SEVERITY = ["ok", "retry", "?", "plan", "bad"];

const key = process.env.API_ETHERSCAN_KEY ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(chainId, params) {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ chainid: chainId, ...params, apikey: key })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) return { ok: false, text: `HTTP ${res.status}` };
  const body = await res.json();
  const text = typeof body.result === "string" ? body.result : body.message;
  return { ok: body.status === "1", text, body };
}

// Turns an Etherscan answer into a verdict. Messages are matched loosely: Etherscan rewords them over time.
function classify({ ok, text }) {
  if (ok) return ["ok", ""];
  if (/invalid api key|missing\/invalid/i.test(text)) return ["bad", "key rejected"];
  if (/not supported for this chain|upgrade your api plan|paid/i.test(text)) return ["plan", text];
  if (/rate limit|max calls/i.test(text)) return ["retry", text];
  return ["?", text];
}

(async () => {
  if (!key) {
    console.error("API_ETHERSCAN_KEY is not set (environment or .env).");
    process.exitCode = 1;
    return;
  }
  console.log(`Key present (${key.length} characters). Checking ${CHAINS.length} chains against ${API}\n`);

  let worst = "ok";
  for (const [id, name] of CHAINS) {
    // getsourcecode: the read verify.js uses to see whether the contract is already verified.
    const read = await call(id, { module: "contract", action: "getsourcecode", address: VESTIGE });
    await sleep(PACE_MS);
    // checkverifystatus with an unknown guid: reaches the verification endpoint without submitting anything.
    // A working key gets "Unable to locate..." (status 0), so only a rejection of the key itself counts as failure.
    const submit = await call(id, { module: "contract", action: "checkverifystatus", guid: GUID });
    await sleep(PACE_MS);

    const [readVerdict, readNote] = classify(read);
    let [submitVerdict, submitNote] = classify(submit);
    if (submitVerdict === "?" && /unable to locate|pending|fail/i.test(submit.text)) [submitVerdict, submitNote] = ["ok", ""];

    const verified = read.ok && read.body.result?.[0]?.SourceCode ? "verified" : read.ok ? "not verified yet" : "";
    console.log(`${name.padEnd(14)} read ${readVerdict.padEnd(5)} verify ${submitVerdict.padEnd(5)} ${verified}${readNote || submitNote ? "  " + (readNote || submitNote) : ""}`);
    for (const v of [readVerdict, submitVerdict]) if (SEVERITY.indexOf(v) > SEVERITY.indexOf(worst)) worst = v;
  }

  const summary = {
    ok: "The key works on every chain.",
    bad: "Etherscan rejected the key. Check API_ETHERSCAN_KEY in .env (no quotes or spaces).",
    plan: "The key works, but its plan does not cover every chain listed. Sourcify still verifies those chains; Etherscan needs a paid plan for them.",
    "?": "Unexpected answers above; read them before relying on the key.",
    retry: "Rate limited; run again in a few seconds.",
  };
  console.log("\n" + summary[worst]);
  if (worst !== "ok") process.exitCode = 1;
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
