import { appShortName } from '@/lib/build-config'

/**
 * Format a number according to the current locale
 */
export const formatNumber = (num: number, options: Intl.NumberFormatOptions = {}): string => {
  const lang = localStorage.getItem(`${appShortName}-language`) || 'en';
  
  // Default options if none provided
  const defaultOptions: Intl.NumberFormatOptions = {};
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.NumberFormat(lang, formatOptions).format(num);
};

/**
 * Format a number as currency according to the current locale
 */
export const formatCurrency = (num: number, currency: string = 'USD', options: Intl.NumberFormatOptions = {}): string => {
  const lang = localStorage.getItem(`${appShortName}-language`) || 'en';

  // Default currency options
  const defaultOptions: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: currency,
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.NumberFormat(lang, formatOptions).format(num);
};

/**
 * Format a percentage according to the current locale
 */
export const formatPercentage = (num: number, options: Intl.NumberFormatOptions = {}): string => {
  const lang = localStorage.getItem(`${appShortName}-language`) || 'en';

  // Default percentage options
  const defaultOptions: Intl.NumberFormatOptions = {
    style: 'percent',
  };
  
  const formatOptions = { ...defaultOptions, ...options };
  
  return new Intl.NumberFormat(lang, formatOptions).format(num);
};