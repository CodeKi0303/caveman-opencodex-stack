const ceiling = 512 * 1024 ** 2;

export function validateRequestLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ceiling) throw Error('Invalid request limit');
  return bytes;
}

export const MAX_REQUEST_BYTES = validateRequestLimit(Number(process.env.MAX_REQUEST_BYTES || ceiling));
