const MASK64 = 0xffffffffffffffffn;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl64(value, shift) {
  const s = BigInt(shift);
  return ((value << s) | (value >> (64n - s))) & MASK64;
}

function keccakF23(state) {
  for (let round = 1; round < 24; round++) {
    const c0 = state[0] ^ state[5] ^ state[10] ^ state[15] ^ state[20];
    const c1 = state[1] ^ state[6] ^ state[11] ^ state[16] ^ state[21];
    const c2 = state[2] ^ state[7] ^ state[12] ^ state[17] ^ state[22];
    const c3 = state[3] ^ state[8] ^ state[13] ^ state[18] ^ state[23];
    const c4 = state[4] ^ state[9] ^ state[14] ^ state[19] ^ state[24];

    const d0 = c4 ^ rotl64(c1, 1);
    const d1 = c0 ^ rotl64(c2, 1);
    const d2 = c1 ^ rotl64(c3, 1);
    const d3 = c2 ^ rotl64(c4, 1);
    const d4 = c3 ^ rotl64(c0, 1);

    state[0] ^= d0; state[5] ^= d0; state[10] ^= d0; state[15] ^= d0; state[20] ^= d0;
    state[1] ^= d1; state[6] ^= d1; state[11] ^= d1; state[16] ^= d1; state[21] ^= d1;
    state[2] ^= d2; state[7] ^= d2; state[12] ^= d2; state[17] ^= d2; state[22] ^= d2;
    state[3] ^= d3; state[8] ^= d3; state[13] ^= d3; state[18] ^= d3; state[23] ^= d3;
    state[4] ^= d4; state[9] ^= d4; state[14] ^= d4; state[19] ^= d4; state[24] ^= d4;

    const b0 = state[0];
    const b10 = rotl64(state[1], 1);
    const b20 = rotl64(state[2], 62);
    const b5 = rotl64(state[3], 28);
    const b15 = rotl64(state[4], 27);
    const b16 = rotl64(state[5], 36);
    const b1 = rotl64(state[6], 44);
    const b11 = rotl64(state[7], 6);
    const b21 = rotl64(state[8], 55);
    const b6 = rotl64(state[9], 20);
    const b7 = rotl64(state[10], 3);
    const b17 = rotl64(state[11], 10);
    const b2 = rotl64(state[12], 43);
    const b12 = rotl64(state[13], 25);
    const b22 = rotl64(state[14], 39);
    const b23 = rotl64(state[15], 41);
    const b8 = rotl64(state[16], 45);
    const b18 = rotl64(state[17], 15);
    const b3 = rotl64(state[18], 21);
    const b13 = rotl64(state[19], 8);
    const b14 = rotl64(state[20], 18);
    const b24 = rotl64(state[21], 2);
    const b9 = rotl64(state[22], 61);
    const b19 = rotl64(state[23], 56);
    const b4 = rotl64(state[24], 14);

    state[0] = b0 ^ ((~b1) & b2); state[1] = b1 ^ ((~b2) & b3); state[2] = b2 ^ ((~b3) & b4); state[3] = b3 ^ ((~b4) & b0); state[4] = b4 ^ ((~b0) & b1);
    state[5] = b5 ^ ((~b6) & b7); state[6] = b6 ^ ((~b7) & b8); state[7] = b7 ^ ((~b8) & b9); state[8] = b8 ^ ((~b9) & b5); state[9] = b9 ^ ((~b5) & b6);
    state[10] = b10 ^ ((~b11) & b12); state[11] = b11 ^ ((~b12) & b13); state[12] = b12 ^ ((~b13) & b14); state[13] = b13 ^ ((~b14) & b10); state[14] = b14 ^ ((~b10) & b11);
    state[15] = b15 ^ ((~b16) & b17); state[16] = b16 ^ ((~b17) & b18); state[17] = b17 ^ ((~b18) & b19); state[18] = b18 ^ ((~b19) & b15); state[19] = b19 ^ ((~b15) & b16);
    state[20] = b20 ^ ((~b21) & b22); state[21] = b21 ^ ((~b22) & b23); state[22] = b22 ^ ((~b23) & b24); state[23] = b23 ^ ((~b24) & b20); state[24] = b24 ^ ((~b20) & b21);

    state[0] ^= RC[round];
    for (let i = 0; i < 25; i++) state[i] &= MASK64;
  }
}

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i++) value |= BigInt(bytes[offset + i] || 0) << (8n * BigInt(i));
  return value;
}

function writeU64LE(bytes, offset, value) {
  let current = value & MASK64;
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number(current & 0xffn);
    current >>= 8n;
  }
}

export function deepSeekHashV1(input) {
  const data = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input || ""));
  const rate = 136;
  const state = Array.from({ length: 25 }, () => 0n);

  let offset = 0;
  while (offset + rate <= data.length) {
    for (let i = 0; i < rate / 8; i++) state[i] ^= readU64LE(data, offset + i * 8);
    keccakF23(state);
    offset += rate;
  }

  const finalBlock = new Uint8Array(rate);
  finalBlock.set(data.subarray(offset));
  finalBlock[data.length - offset] = 0x06;
  finalBlock[rate - 1] |= 0x80;
  for (let i = 0; i < rate / 8; i++) state[i] ^= readU64LE(finalBlock, i * 8);
  keccakF23(state);

  const out = new Uint8Array(32);
  writeU64LE(out, 0, state[0]);
  writeU64LE(out, 8, state[1]);
  writeU64LE(out, 16, state[2]);
  writeU64LE(out, 24, state[3]);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildPowPrefix(salt, expireAt) {
  return `${salt}_${expireAt}_`;
}

export async function solveDeepSeekPow(challenge, signal) {
  const { algorithm, challenge: challengeHex, salt, expire_at: expireAt, difficulty } = challenge || {};
  if (algorithm !== "DeepSeekHashV1") throw new Error(`Unsupported DeepSeek PoW algorithm: ${algorithm || "unknown"}`);
  if (!challengeHex || !salt || !Number.isFinite(Number(expireAt)) || !Number.isFinite(Number(difficulty))) throw new Error("Invalid DeepSeek PoW challenge");

  const prefix = buildPowPrefix(String(salt), Number(expireAt));
  const target = String(challengeHex).toLowerCase();
  const max = Number(difficulty);

  for (let nonce = 0; nonce < max; nonce++) {
    if ((nonce & 0x3ff) === 0 && signal?.aborted) throw new Error("DeepSeek PoW aborted");
    const hash = bytesToHex(deepSeekHashV1(prefix + String(nonce)));
    if (hash === target) return nonce;
  }
  throw new Error("DeepSeek PoW solve failed");
}

export function buildDeepSeekPowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

