/**
 * Brand marks for the local-agent runtimes. All use `currentColor` so they
 * render as a white glyph inside the coral chip container in the sidebar,
 * exactly like the lucide icons they replace.
 *
 * Two provenances, hence two viewBoxes — each mark keeps its source grid rather
 * than being re-plotted onto a shared one, since re-scaling by hand is how
 * traced geometry drifts:
 *
 *  - opencode / pi: hand-drawn on a 28×28 grid sampled from the reference PNGs
 *    (Downloads/opencode.png, Downloads/pi-agent-logo.png).
 *  - claude / cursor: the upstream vector marks, 16×16 and 24×24 respectively.
 *
 * These identify third-party runtimes in our own UI — nominative use. The marks
 * remain the trademarks of Anthropic and Anysphere; do not restyle them into
 * something that reads as a TeamClaw mark.
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

/**
 * Claude Code: the Anthropic starburst — an off-kilter radial burst, not a
 * letterform. Upstream vector on a 16×16 grid (Bootstrap Icons' `claude`).
 */
export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
    </svg>
  )
}

/**
 * Cursor: the layered cube seen corner-on, hollowed by the second subpath.
 * Needs `evenodd` — with the default nonzero rule the cut-out fills solid.
 * Upstream vector on a 24×24 grid.
 */
export function CursorMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path fillRule="evenodd" clipRule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
    </svg>
  )
}
