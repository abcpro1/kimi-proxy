import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const randomId = customAlphabet(alphabet, 12);

export function createRequestId(prefix = "req"): string {
  return `${prefix}_${randomId()}`;
}
