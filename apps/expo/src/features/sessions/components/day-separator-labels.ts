import { t } from "../../../lib/i18n";
import { dateLocale } from "../../../lib/i18n/locale";

/**
 * Returns the localized label for the day boundary above a message
 * dated `iso`. Mirrors `formatRelativeTime` for the Sessions list, but
 * resolves to a date eyebrow instead of a time delta.
 *
 * - same calendar day in `nowMs` → "Today"
 * - exactly one calendar day earlier → "Yesterday"
 * - otherwise → locale-formatted date (`dateLocale()`: zh-CN or en-US)
 */
export function dayLabel(iso: string, nowMs: number = Date.now()): string {
  const dateMs = Date.parse(iso);
  if (Number.isNaN(dateMs)) return "";
  const target = new Date(dateMs);
  const now = new Date(nowMs);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(target)) / 86400000);
  if (dayDiff === 0) return t("Today");
  if (dayDiff === 1) return t("Yesterday");
  const options: Intl.DateTimeFormatOptions =
    target.getFullYear() === now.getFullYear()
      ? { month: "long", day: "numeric" }
      : { year: "numeric", month: "long", day: "numeric" };
  return target.toLocaleDateString(dateLocale(), options);
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
