/** Word tokenizer that works across scripts (Latin, Cyrillic, and friends). */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** Clamp a raw signal into the 0..1 suspicion range. */
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Short, safe excerpt for messages. Never leaks a full response into logs. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '\u2026';
}
