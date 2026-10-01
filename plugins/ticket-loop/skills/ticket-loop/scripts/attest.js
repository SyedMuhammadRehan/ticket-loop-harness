// Ed25519 signing for run attestations, on Node's built-in crypto.
//
// The chain's HMAC key proves the record to whoever holds that key, which is only the machine
// that ran the loop. A signature proves it to anyone holding the public key. The signing key
// still sits wherever the loop runs, so a signature says the record was not changed after it
// was signed, and by which key — not that the signing machine behaved.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEY = 'TICKET_LOOP_SIGNING_KEY';
const KEY_ID_HEX = 32;

function keyPaths() {
  const priv = process.env[ENV_KEY] || path.join(os.homedir(), '.claude', 'ticket-loop', 'signing', 'ed25519.pem');
  return { priv, pub: `${priv}.pub` };
}

// The id is the hash of the public key's DER bytes, so it names the key, not a file.
function keyIdOf(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, KEY_ID_HEX);
}

function keygen() {
  const { priv, pub } = keyPaths();
  if (fs.existsSync(priv)) return { error: `a signing key already exists at ${priv}; it is not replaced`, priv };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.mkdirSync(path.dirname(priv), { recursive: true });
  fs.writeFileSync(priv, privPem, { mode: 0o600 });
  fs.writeFileSync(pub, pubPem);
  return { priv, pub, keyId: keyIdOf(pubPem) };
}

function loadSigner() {
  const { priv } = keyPaths();
  let privPem;
  try {
    privPem = fs.readFileSync(priv, 'utf8');
  } catch {
    return { error: `no signing key at ${priv}; create one with "ledger.js keygen" or set ${ENV_KEY}` };
  }
  try {
    const privateKey = crypto.createPrivateKey(privPem);
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
  } catch (err) {
    return { error: `the signing key at ${priv} could not be read (${err.message})` };
  }
}

function sign(privateKey, text) {
  return crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
}

module.exports = { keygen, loadSigner, sign, keyIdOf, keyPaths, ENV_KEY };
