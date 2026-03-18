

/**
 * Format a date according to the current locale
 */
export const formatDate = (date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string => {
  const lang = localStorage.getItem('teamclaw-language') || 'en';
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  // Default options if none provided
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.DateTimeFormat(lang, formatOptions).format(dateObj);
};

/**
 * Format time according to the current locale
 */
export const formatTime = (date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string => {
  const lang = localStorage.getItem('teamclaw-language') || 'en';
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  // Default time options
  const defaultOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.DateTimeFormat(lang, formatOptions).format(dateObj);
};

/**
 * Format datetime according to the current locale
 */
export const formatDateTime = (date: Date | string | number, options: Intl.DateTimeFormatOptions = {}): string => {
  const lang = localStorage.getItem('teamclaw-language') || 'en';
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  // Default datetime options
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.DateTimeFormat(lang, formatOptions).format(dateObj);
};

/**
 * Format a date as a short relative time string (e.g., "Just now", "5m ago", "3d ago").
 * Pure function — safe to use outside React components.
 */
export function formatRelativeDate(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/**
 * Format a date as a session grouping label: "Today", "Yesterday", or "N days ago".
 */
export function formatSessionDate(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays} days ago`
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
export const formatRelativeTime = (date: Date | string | number): string => {
  const lang = localStorage.getItem('teamclaw-language') || 'en';
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - dateObj.getTime()) / 1000);
  
  // Define thresholds in seconds
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  
  if (diffInSeconds < 60) {
    return rtf.format(-Math.floor(diffInSeconds), 'second');
  } else if (diffInSeconds < 3600) {
    return rtf.format(-Math.floor(diffInSeconds / 60), 'minute');
  } else if (diffInSeconds < 86400) {
    return rtf.format(-Math.floor(diffInSeconds / 3600), 'hour');
  } else if (diffInSeconds < 2592000) { // 30 days
    return rtf.format(-Math.floor(diffInSeconds / 86400), 'day');
  } else if (diffInSeconds < 31536000) { // 365 days
    return rtf.format(-Math.floor(diffInSeconds / 2592000), 'month');
  } else {
    return rtf.format(-Math.floor(diffInSeconds / 31536000), 'year');
  }
};