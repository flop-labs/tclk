// SPDX-License-Identifier: Apache-2.0

const RFC3339_INSTANT = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parse a timezone-qualified RFC 3339 instant, rejecting impossible dates. */
export function parseRfc3339Instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_INSTANT.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day > daysInMonth(year, month)) return null;

  const timestampMs = Date.parse(value);
  return Number.isSafeInteger(timestampMs) && timestampMs >= 0 ? timestampMs : null;
}
