/**
 * Returns the localized label for the day boundary above a message
 * dated `iso`. Mirrors `formatRelativeTime` for the Sessions list, but
 * resolves to a date eyebrow instead of a time delta.
 *
 * - same calendar day in `nowMs` → "今天"
 * - exactly one calendar day earlier → "昨天"
 * - within current ISO year → "M月D日"
 * - older → "YYYY年M月D日"
 */
export function dayLabel(iso: string, nowMs: number = Date.now()): string {
  const dateMs = Date.parse(iso);
  if (Number.isNaN(dateMs)) return "";
  const target = new Date(dateMs);
  const now = new Date(nowMs);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(target)) / 86400000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (target.getFullYear() === now.getFullYear()) {
    return `${target.getMonth() + 1}月${target.getDate()}日`;
  }
  return `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`;
}

export function isSameCalendarDay(aIso: string, bIso: string): boolean {
  const a = new Date(Date.parse(aIso));
  const b = new Date(Date.parse(bIso));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
