/**
 * The sentence to put in front of somebody when a write on the person panel fails.
 *
 * A refusal arrives as two pieces: a machine-readable `reason` a module translates, and the English
 * sentence the router wrote for a reader. Nothing under `people.*`, `employment.*` or `documents.*`
 * sends a reason today — their refusals are a record that has gone, a date before the period it
 * would change, and a field the server will not take — so this uses the second, and only for the
 * codes that carry a sentence somebody wrote. Everything else is machine text in English: a network
 * drop, a 500, a gateway, and `Forbidden` and `Unauthorized`, which are one word each. A toast is
 * the last place to paste any of them, so they fall back to the caller's own string.
 *
 * When one of those procedures does grow a reason, it is read the way `ClockControls.svelte` reads
 * a punch's — keyed by the code, never by the sentence.
 */
const READABLE = new Set(['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'])

export function explainRefusal(error: unknown, fallback: string): string {
  const failure = error as { code?: unknown; message?: string }
  const readable = typeof failure.code === 'string' && READABLE.has(failure.code)
  return (readable ? failure.message : '') || fallback
}
