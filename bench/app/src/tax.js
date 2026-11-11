'use strict';
const { domainError } = require('./money.js');

const RATES = { PK: 17, AE: 5, US: 0 };

function rateFor(region) {
  if (!Object.prototype.hasOwnProperty.call(RATES, region)) throw domainError('UNKNOWN_REGION', `no tax rate for ${region}`);
  return RATES[region];
}

function taxFor(amountCents, region) {
  return Math.floor((amountCents * rateFor(region)) / 100);
}

module.exports = { taxFor, rateFor, RATES };
