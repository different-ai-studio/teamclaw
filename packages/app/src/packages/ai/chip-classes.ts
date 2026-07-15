const CHIP_CLASS_NAMES = [
  "file-chip",
  "role-chip",
  "skill-chip",
  "command-chip",
  "member-chip",
  "page-link-chip",
] as const;

export function isComposerChipElement(el: HTMLElement | null | undefined): boolean {
  if (!el?.classList) return false;
  return CHIP_CLASS_NAMES.some((name) => el.classList.contains(name));
}

export const COMPOSER_CHIP_SELECTOR =
  ".file-chip, .role-chip, .skill-chip, .command-chip, .member-chip, .page-link-chip";
