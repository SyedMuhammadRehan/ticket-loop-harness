'use strict';
const crypto = require('crypto');

const SESSION_TTL_MS = 60 * 60 * 1000;

function signature(secret, userId, expiresAt) {
  return crypto.createHmac('sha256', secret).update(`${userId}.${expiresAt}`).digest('hex');
}

function issue(secret, userId, now = Date.now()) {
  const expiresAt = now + SESSION_TTL_MS;
  return `${userId}.${expiresAt}.${signature(secret, userId, expiresAt)}`;
}

// The user id a token was issued to, or null when it is malformed, forged or expired.
function verify(secret, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresText, given] = parts;
  const expiresAt = Number(expiresText);
  if (!userId || !Number.isInteger(expiresAt)) return null;
  const expected = Buffer.from(signature(secret, userId, expiresAt));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return now < expiresAt ? userId : null;
}

module.exports = { issue, verify, SESSION_TTL_MS };
