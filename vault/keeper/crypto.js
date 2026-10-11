// The Vault's cryptography. One random 256-bit data key, made inside the enclave on first boot and
// stored only wrapped by Cloud KMS (which unwraps it for an attested image alone). Every other key is
// derived from it with HKDF, one per purpose, so no key is ever used for two things.
import {createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual} from "node:crypto";

export function derive(dataKey, purpose) {
  return Buffer.from(hkdfSync("sha256", dataKey, Buffer.alloc(0), Buffer.from("constellation-vault/" + purpose), 32));
}

// every GCM tag is 16 bytes, and a decipher accepts no other length
export const TAG = 16;

// -- small values (a snapshot's file, its manifest): nonce(12) | ciphertext | tag(16), with AAD
export function seal(key, plain, aad) {
  const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
}
export function open(key, box, aad) {
  if (box.length < 28) throw new Error("sealed value too short");
  const d = createDecipheriv("aes-256-gcm", key, box.subarray(0, 12), {authTagLength: TAG});
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(box.subarray(box.length - 16));
  return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
}
export const mac = (key, data) => createHmac("sha256", key).update(data).digest();
export const sameMac = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// -- media: chunked so that a range of a video can be read and decrypted on its own.
//   header: "CVB1" | prefix(8) | size(u64) | metaLen(u32) | meta sealed (AAD = the 20 bytes before it)
//   chunk i (CHUNK plaintext bytes, the last shorter): AES-GCM, nonce = prefix | u32(i),
//   AAD = the header's first 20 bytes | u32(i) -- so changing the size, swapping, reordering or
//   moving a chunk from another file fails to decrypt.
export const CHUNK = 64 * 1024, MAGIC = Buffer.from("CVB1");

export function headerFor(key, prefix, size, meta) {
  const fixed = Buffer.alloc(20);
  MAGIC.copy(fixed, 0); prefix.copy(fixed, 4); fixed.writeBigUInt64BE(BigInt(size), 12);
  const m = seal(key, Buffer.from(JSON.stringify(meta)), fixed);
  const len = Buffer.alloc(4); len.writeUInt32BE(m.length);
  return Buffer.concat([fixed, len, m]);
}
export function readHeader(key, buf) {           // -> {fixed, prefix, size, meta, length} or null if more bytes are needed
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("not a vault blob");
  const metaLen = buf.readUInt32BE(20);
  if (buf.length < 24 + metaLen) return {need: 24 + metaLen};
  const fixed = buf.subarray(0, 20);
  return {fixed: Buffer.from(fixed), prefix: Buffer.from(buf.subarray(4, 12)), size: Number(buf.readBigUInt64BE(12)),
    meta: JSON.parse(open(key, buf.subarray(24, 24 + metaLen), fixed).toString()), length: 24 + metaLen};
}
const chunkNonce = (prefix, i) => { const n = Buffer.alloc(12); prefix.copy(n, 0); n.writeUInt32BE(i, 8); return n; };
const chunkAad = (fixed, i) => { const a = Buffer.alloc(24); fixed.copy(a, 0); a.writeUInt32BE(i, 20); return a; };
export function sealChunk(key, fixed, i, plain) {
  const c = createCipheriv("aes-256-gcm", key, chunkNonce(fixed.subarray(4, 12), i), {authTagLength: TAG});
  c.setAAD(chunkAad(fixed, i));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
export function openChunk(key, fixed, i, box) {
  const d = createDecipheriv("aes-256-gcm", key, chunkNonce(fixed.subarray(4, 12), i), {authTagLength: TAG});
  d.setAAD(chunkAad(fixed, i));
  d.setAuthTag(box.subarray(box.length - TAG));
  return Buffer.concat([d.update(box.subarray(0, box.length - TAG)), d.final()]);
}
