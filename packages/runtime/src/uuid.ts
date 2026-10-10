// UUIDv7 (RFC 9562, section 5.7): 48 bits of Unix milliseconds, then version, then a
// 12-bit counter in `rand_a` (section 6.2, method 1), then variant and 62 random bits.
// The counter makes ids made in one millisecond sort in creation order; the text form is
// fixed-width lower-case hex, so string order equals byte order.
let lastMillis = -1;
let counter = 0;

/** A time-ordered UUID. Increases strictly within one process (one copy of this module), even
 * inside one millisecond. `now` is honoured only when it is ahead of the last id issued; otherwise
 * the id continues from the last one, so a fixed `now` in a test is not reproducible. */
export function uuidv7(now: number = Date.now()): string {
  if (now > lastMillis) {
    lastMillis = now;
    // Start below the top of the range so a burst in one millisecond has room to count.
    counter = crypto.getRandomValues(new Uint16Array(1))[0]! & 0x1ff;
  } else {
    // Same millisecond, or the clock stepped back: keep counting from the last id.
    counter++;
    if (counter > 0xfff) { lastMillis++; counter = 0; }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(lastMillis);
  for (let index = 0; index < 6; index++) bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
