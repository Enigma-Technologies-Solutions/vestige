// Client-side helpers mirroring what a browser checkpoint (WebCrypto) and witness (WebAuthn passkey) produce.
const crypto = require("node:crypto");

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = N / 2n;

const hex = (buf) => "0x" + Buffer.from(buf).toString("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

function generateKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    pub: { x: hex(Buffer.from(jwk.x, "base64url")), y: hex(Buffer.from(jwk.y, "base64url")) },
  };
}

// ECDSA-P256-SHA256 over `data`, returned as low-s (r, s) as required by OpenZeppelin's P256.verify.
function sign(privateKey, data) {
  const raw = crypto.sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const r = BigInt(hex(raw.subarray(0, 32)));
  let s = BigInt(hex(raw.subarray(32)));
  if (s > HALF_N) s = N - s;
  const word = (v) => "0x" + v.toString(16).padStart(64, "0");
  return { r: word(r), s: word(s) };
}

// Builds a WebAuthn assertion (`webauthn.get`) as an authenticator would, over a 32-byte challenge.
function webauthnAssert(privateKey, challenge, opts = {}) {
  const { rpId = "vestige.test", origin = "https://vestige.test", flags = 0x05, counter = 1, type = "webauthn.get" } = opts;
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), counterBytes]);
  const clientDataJSON = JSON.stringify({
    type,
    challenge: b64url(Buffer.from(challenge.slice(2), "hex")),
    origin,
    crossOrigin: false,
  });
  const { r, s } = sign(privateKey, Buffer.concat([authenticatorData, sha256(clientDataJSON)]));
  return {
    r,
    s,
    challengeIndex: clientDataJSON.indexOf('"challenge":"'),
    typeIndex: clientDataJSON.indexOf('"type":"'),
    authenticatorData: hex(authenticatorData),
    clientDataJSON,
  };
}

module.exports = { N, HALF_N, generateKey, sign, webauthnAssert };
