/** Pointer cursor for interactive controls inside sidebar surfaces. */
export const SIDEBAR_INTERACTIVE_CURSOR = [
  '[&_button:not(:disabled)]:cursor-pointer',
  '[&_[data-slot=button]:not(:disabled)]:cursor-pointer',
  '[&_a[href]]:cursor-pointer',
  '[&_[role=menuitem]:not([data-disabled])]:!cursor-pointer',
  '[&_[role=option]:not([data-disabled])]:!cursor-pointer',
  '[&_[role=button]:not([aria-disabled=true])]:cursor-pointer',
].join(' ')
