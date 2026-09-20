import { ROOM_CODE_PREFIX } from './protocol';

const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generateRoomCode(random = crypto.getRandomValues(new Uint8Array(4))): string {
  return ROOM_CODE_PREFIX + Array.from(random, byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('');
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
