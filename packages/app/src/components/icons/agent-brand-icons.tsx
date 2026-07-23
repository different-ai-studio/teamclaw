/**
 * Brand marks for the local-agent runtimes, drawn to match the reference logos
 * (Downloads/opencode.png, Downloads/pi-agent-logo.png). Both use `currentColor`
 * so they render as a white glyph inside the coral chip container in the sidebar,
 * exactly like the lucide icons they replace.
 *
 * Geometry is on a 28×28 grid sampled from the source PNGs.
 */

/** opencode: a bordered portrait square with a hollow slot (evenodd cuts the hole). */
export function OpencodeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 2h17v24H5V2Zm4 5v14h9V7H9Z"
      />
    </svg>
  )
}

/** pi-agent: the pixel "Pi" mark — head with a square counter plus the dotted stem. */
export function PiAgentMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M6 6h4v16H6zM10 6h8v4h-8zM14 10h4v4h-4zM10 14h4v4h-4zM18 14h4v8h-4z" />
    </svg>
  )
}
