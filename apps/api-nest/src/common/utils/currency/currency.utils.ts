import getSymbolFromCurrency from 'currency-symbol-map';

/**
 * Format currency values with appropriate symbol
 * @param value - Value to format
 * @param currency - Currency code (e.g., 'USD', 'EUR', 'GBP')
 * @returns Formatted currency string
 */
export const formatCurrency = (
  value: number | null | undefined,
  currency: string = 'USD',
): string => {
  if (value === null || value === undefined || isNaN(value)) {
    return formatCurrency(0, currency);
  }

  const symbol = getSymbolFromCurrency(currency) || '$';
  return `${symbol}${parseFloat(value.toString()).toFixed(2)}`;
};

/**
 * Create a bound formatCurrency function for a specific currency
 * @param currency - Currency code
 * @returns Bound formatCurrency function
 */
export const createCurrencyFormatter = (currency: string = 'USD'): ((value: number) => string) => {
  return (value: number) => formatCurrency(value, currency);
};

/**
 * Get currency symbol for a given currency code
 * @param currency - Currency code
 * @returns Currency symbol
 */
export const getCurrencySymbol = (currency: string = 'USD'): string => {
  return getSymbolFromCurrency(currency) || '$';
};

/**
 * Parse currency string to number
 * @param currencyString - Currency string (e.g., '$100.50')
 * @returns Parsed number
 */
export const parseCurrency = (currencyString: string | number): number => {
  if (typeof currencyString === 'number') {
    return currencyString;
  }

  if (typeof currencyString !== 'string') {
    return 0;
  }

  // Remove currency symbols and parse, but keep digits, decimal points, and negative signs
  const cleaned = currencyString.replace(/[^\d.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
};

/**
 * Validate currency code
 * @param currency - Currency code to validate
 * @returns True if valid currency code
 */
export const isValidCurrency = (currency: string): boolean => {
  if (!currency || typeof currency !== 'string') {
    return false;
  }

  // Check if currency symbol exists (basic validation)
  const symbol = getSymbolFromCurrency(currency);
  return symbol !== undefined && symbol !== currency;
};

/**
 * Get list of supported currencies
 * @returns Array of common currency codes
 */
export const getSupportedCurrencies = (): string[] => {
  return [
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'CAD',
    'AUD',
    'CHF',
    'CNY',
    'SEK',
    'NZD',
    'MXN',
    'SGD',
    'HKD',
    'NOK',
    'TRY',
    'RUB',
    'INR',
    'BRL',
    'ZAR',
    'KRW',
  ];
};
