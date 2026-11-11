'use strict';

const CENTS_PER_UNIT = 100;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

function domainError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toCents(text) {
  const value = String(text).trim();
  if (!AMOUNT.test(value)) throw domainError('BAD_AMOUNT', `"${text}" is not an amount`);
  const [units, fraction = ''] = value.split('.');
  return Number(units) * CENTS_PER_UNIT + Number(fraction.padEnd(2, '0'));
}

function format(cents) {
  if (!Number.isInteger(cents)) throw domainError('BAD_AMOUNT', 'an amount is a whole number of cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / CENTS_PER_UNIT)}.${String(abs % CENTS_PER_UNIT).padStart(2, '0')}`;
}

function percentOf(cents, percent) {
  return Math.floor((cents * percent) / 100);
}

module.exports = { toCents, format, percentOf, domainError };
