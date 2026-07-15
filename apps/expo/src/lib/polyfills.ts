import { Buffer } from "buffer";

/**
 * mqtt v5 (and several packet-encoding libs that ship for both Node and
 * React Native) call `Buffer.from(...)` at module load time. React Native
 * does not provide a global Buffer, so we install one before any other
 * module imports it. Keep this file as the first import of the root layout.
 */
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
