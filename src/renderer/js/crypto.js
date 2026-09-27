/**
 * Identity, key agreement and payload crypto.
 *
 * An identity owns TWO P-256 key pairs, because WebCrypto refuses to sign with
 * an ECDH key and refuses to derive with an ECDSA key:
 *   - sign pair  (ECDSA) proves possession, this is the identity itself
 *   - dh   pair  (ECDH)  produces the session secret
 *
 * The fingerprint is SHA-256 over both public keys, so a peer cannot swap one
 * half of the identity without the fingerprint changing.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* --------------------------------------------------------------- base64 --- */
export function b64(bytes) {
  let s = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(text) {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const b64u = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (text) => unb64(String(text).trim());

export function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(prefix = '') {
  return prefix + hex(crypto.getRandomValues(new Uint8Array(16)));
}

/* ------------------------------------------------------------- identity --- */
const CURVE = 'P-256';

export async function createIdentity() {
  const sign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: CURVE }, true, ['sign', 'verify']);
  const dh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits', 'deriveKey']);
  const signPub = new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey));
  const dhPub = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return {
    v: 2,
    id: randomId(),
    createdAt: Date.now(),
    pubRaw: b64u(signPub),
    dhRaw: b64u(dhPub),
    privJwk: await crypto.subtle.exportKey('jwk', sign.privateKey),
    dhJwk: await crypto.subtle.exportKey('jwk', dh.privateKey),
    fingerprint: await fingerprintOf(signPub, dhPub),
  };
}

export async function restoreIdentity(stored) {
  if (!stored || !stored.pubRaw || !stored.privJwk || !stored.dhJwk || !stored.dhRaw) {
    // an identity from an older build (or a half-written profile) cannot be
    // resumed - the ECDH half is gone, so mint a fresh key set and keep the id
    const fresh = await createIdentity();
    if (stored?.id) fresh.id = stored.id;
    return fresh;
  }
  const signPubRaw = unb64u(stored.pubRaw);
  const dhPubRaw = unb64u(stored.dhRaw);
  const publicKey = await crypto.subtle.importKey(
    'raw',
    signPubRaw,
    { name: 'ECDSA', namedCurve: CURVE },
    true,
    ['verify']
  );
  const privateKey = await crypto.subtle.importKey('jwk', stored.privJwk, { name: 'ECDSA', namedCurve: CURVE }, true, ['sign']);
  const dhKey = await crypto.subtle.importKey('jwk', stored.dhJwk, { name: 'ECDH', namedCurve: CURVE }, true, [
    'deriveBits',
    'deriveKey',
  ]);
  return {
    v: 2,
    id: stored.id,
    createdAt: stored.createdAt || Date.now(),
    pubRaw: stored.pubRaw,
    dhRaw: stored.dhRaw,
    privJwk: stored.privJwk,
    dhJwk: stored.dhJwk,
    publicKey,
    privateKey,
    dhKey,
    fingerprint: await fingerprintOf(signPubRaw, dhPubRaw),
  };
}

/** ECDSA public key: verifies the peer's handshake signature. */
export function importPublic(pubRawB64) {
  return crypto.subtle.importKey('raw', unb64u(pubRawB64), { name: 'ECDSA', namedCurve: CURVE }, true, ['verify']);
}

/** ECDH public key: feeds the key agreement. */
export function importDhPublic(dhRawB64) {
  return crypto.subtle.importKey('raw', unb64u(dhRawB64), { name: 'ECDH', namedCurve: CURVE }, true, []);
}

export async function fingerprintOf(signPubRaw, dhPubRaw) {
  const material = concat(
    enc.encode('MOUTH-ID/2|'),
    new Uint8Array(signPubRaw),
    new Uint8Array(dhPubRaw)
  );
  return hex(await crypto.subtle.digest('SHA-256', material));
}

/** 16 groups of 4 hex chars - the full SHA-256, 64 digits. */
export function formatFingerprint(fp) {
  const clean = String(fp || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 64);
  const groups = [];
  for (let i = 0; i < 64; i += 4) groups.push(clean.slice(i, i + 4));
  return groups.filter((g) => g.trim()).join(' ');
}

export function shortFingerprint(fp) {
  const clean = String(fp || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return clean.slice(0, 4) + '…' + clean.slice(-4);
}

/** Deterministic 12x5 digit code both peers can read aloud. */
export async function safetyNumber(identity, peer) {
  const a = String(identity.fingerprint);
  const b = String(peer.fingerprint || '');
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const material = enc.encode('MOUTH-SAS/1|' + lo + '|' + hi);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  const digits = [...digest.slice(0, 30)].map((n) => n % 10);
  const groups = [];
  for (let i = 0; i < 30; i += 5) groups.push(digits.slice(i, i + 5).join(''));
  return groups;
}

/* ------------------------------------------------------------- session --- */
/**
 * AES-GCM key from ECDH + HKDF, salted with BOTH dh public keys in a stable
 * order, so both sides land on the same key and a swapped half is fatal.
 */
export async function deriveSessionKey(identity, peerDhPublicKey, peerDhRawB64) {
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerDhPublicKey },
    identity.dhKey,
    256
  );
  const mine = unb64u(identity.dhRaw);
  const theirs = unb64u(peerDhRawB64);
  const [lo, hi] = hex(mine) < hex(theirs) ? [mine, theirs] : [theirs, mine];
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(lo, hi)));
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('MOUTH-SESSION/2') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBytes(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: 'AES-GCM', iv, tagLength: 128 };
  if (aad) params.additionalData = aad;
  const ct = await crypto.subtle.encrypt(params, key, bytes);
  return { iv: b64u(iv), ct: b64u(ct) };
}

export async function decryptBytes(key, env, aad) {
  const params = { name: 'AES-GCM', iv: unb64u(env.iv), tagLength: 128 };
  if (aad) params.additionalData = aad;
  const plain = await crypto.subtle.decrypt(params, key, unb64u(env.ct));
  return new Uint8Array(plain);
}

/** Same, but the ciphertext arrives as raw bytes (file chunks, no base64). */
export async function decryptBytesRaw(key, ivB64, ciphertext) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(ivB64), tagLength: 128 },
    key,
    ciphertext
  );
  return new Uint8Array(plain);
}

export async function seal(key, object) {
  return encryptBytes(key, enc.encode(JSON.stringify(object)));
}

export async function unseal(key, env) {
  return JSON.parse(dec.decode(await decryptBytes(key, env)));
}

/* ------------------------------------------------------------ handshake --- */
export async function sign(privateKey, data) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    enc.encode(data)
  );
  return b64u(sig);
}

export async function verify(publicKey, signature, data) {
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      unb64u(signature),
      enc.encode(data)
    );
  } catch {
    return false;
  }
}

export function handshakePayload(ownFp, peerFp, nonce) {
  return `MOUTH-HELLO/1|${ownFp}|${peerFp || ''}|${nonce}`;
}

/* ------------------------------------------------------- invite packing --- */
/** deflate/inflate take and return STRINGS - never pass bytes in here, or the
 *  typed array gets stringified to "123,34,118..." and the code rots. */
async function deflate(text) {
  const stream = new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return dec.decode(await new Response(stream).arrayBuffer());
}

const CODE_MAGIC = 'M1';
/* '.' separates the visual chunks: it is outside the base64url alphabet, while
 * '-' and '_' are part of it and must survive round-trip untouched. */
const CODE_SEP = '.';

/** Compact text blob for manual pairing (copy/paste friendly, no QR needed). */
export async function packCode(obj) {
  const packed = await deflate(JSON.stringify(obj));
  const body = b64u(packed);
  return CODE_MAGIC + CODE_SEP + (body.match(/.{1,76}/g) || ['']).join(CODE_SEP);
}

export async function unpackCode(text) {
  const clean = String(text || '').trim().replace(/\s+/g, '');
  if (!clean) throw new Error('Пустой код');
  if (!clean.startsWith(CODE_MAGIC + CODE_SEP)) throw new Error('Это не код p2pAnon');
  const body = clean.slice(CODE_MAGIC.length + 1).split(CODE_SEP).join('');
  let bytes;
  try {
    bytes = unb64u(body);
  } catch {
    throw new Error('Код повреждён');
  }
  let obj;
  try {
    obj = JSON.parse(await inflate(bytes));
  } catch {
    throw new Error('Код повреждён');
  }
  if (!obj || typeof obj !== 'object') throw new Error('Код повреждён');
  return obj;
}

/* --------------------------------------------------------------- helpers --- */
export function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
