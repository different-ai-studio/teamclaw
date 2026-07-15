const HEX = "0123456789abcdef";

/**
 * v4 UUID generator using Math.random. React Native does not provide
 * `crypto.randomUUID`, and shipping a getRandomValues polyfill is more
 * weight than needed here — the server validates message ownership via
 * the bearer token, so a non-cryptographic UUID is acceptable.
 */
export function uuidV4(): string {
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4";
    } else if (i === 19) {
      out += HEX[(Math.random() * 4) | 8];
    } else {
      out += HEX[(Math.random() * 16) | 0];
    }
  }
  return out;
}
