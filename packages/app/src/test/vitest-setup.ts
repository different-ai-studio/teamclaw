/**
 * Vitest / jsdom shims: globals that exist in real browsers but are missing or
 * incomplete in the test environment, which would otherwise cause unhandled
 * rejections and a non-zero exit code despite all assertions passing.
 */

// --- CSS.escape (used by FileTree querySelector selectors) -----------------
// In some Vitest worker contexts `globalThis.CSS` is undefined.
function cssEscapeIdent(value: string): string {
  const string = String(value)
  const length = string.length
  let index = -1
  let result = ''
  const firstCodeUnit = string.charCodeAt(0)
  while (++index < length) {
    const codeUnit = string.charCodeAt(index)
    if (codeUnit === 0x0000) {
      result += '\uFFFD'
      continue
    }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 &&
        codeUnit >= 0x0030 &&
        codeUnit <= 0x0039 &&
        firstCodeUnit === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `
      continue
    }
    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += string.charAt(index)
      continue
    }
    result += `\\${string.charAt(index)}`
  }
  return result
}

if (typeof globalThis.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: { escape: cssEscapeIdent },
    configurable: true,
    writable: true,
  })
} else if (typeof globalThis.CSS.escape !== 'function') {
  Object.assign(globalThis.CSS, { escape: cssEscapeIdent })
}

// --- Element.scrollIntoView (jsdom stub) -------------------------------------
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function (_options?: ScrollIntoViewOptions) {
    // no-op — layout is not simulated in tests
  }
}

// --- Tauri event plugin (listen() teardown calls into internals) ------------
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (...args: unknown[]) => void }
  }
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
    unregisterListener: () => {},
  }
}
