// SPDX-License-Identifier: Apache-2.0

export function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}
