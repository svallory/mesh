/**
 * Splits a connection's byte stream into lines.
 *
 * A message is one line of UTF-8 ended by `\n`. Lines are split on the newline byte before anything is decoded, so a
 * multi-byte character split across two reads is never cut, and the length limit counts bytes, not characters.
 */

const NEWLINE = 0x0a;

/** What one complete line of the stream yields. */
export type Frame =
  /** The line's text, without its `\n`. A trailing `\r` is kept: JSON parsing ignores it as whitespace. */
  | { readonly kind: "line"; readonly text: string }
  /** A line longer than the limit. Its bytes were discarded up to its `\n`; the stream continues after it. */
  | { readonly kind: "too-long" }
  /** A line that is not valid UTF-8. */
  | { readonly kind: "not-utf8" };

/** One connection's line splitter. Feed it each chunk the socket delivers, in order. */
export class LineReader {
  readonly #maxLineBytes: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  /** The bytes of the current, unfinished line, copied out of the chunks they came in. */
  #parts: Uint8Array[] = [];
  #size = 0;
  /** True while the rest of an over-long line is being skipped. */
  #skipping = false;

  constructor(maxLineBytes: number) {
    this.#maxLineBytes = maxLineBytes;
  }

  /** Takes one chunk and returns every line it completes, in order. An over-long line yields one `too-long` frame. */
  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let start = 0;
    while (start <= chunk.length) {
      const end = chunk.indexOf(NEWLINE, start);
      const complete = end !== -1;
      const stop = complete ? end : chunk.length;
      if (this.#skipping) {
        // The over-long line was already answered; drop its bytes up to its newline.
        if (complete) this.#skipping = false;
      } else if (this.#size + (stop - start) > this.#maxLineBytes) {
        this.#parts = [];
        this.#size = 0;
        frames.push({ kind: "too-long" });
        this.#skipping = !complete;
      } else if (complete) {
        const line = this.#take(chunk.subarray(start, stop));
        const frame = this.#decode(line);
        if (frame) frames.push(frame);
      } else if (stop > start) {
        // Copy: the chunk belongs to the socket, and the line finishes in a later one.
        this.#parts.push(chunk.slice(start, stop));
        this.#size += stop - start;
      }
      if (!complete) break;
      start = end + 1;
    }
    return frames;
  }

  /** The buffered start of the line, joined with its last piece. */
  #take(last: Uint8Array): Uint8Array {
    if (this.#parts.length === 0) return last;
    const line = new Uint8Array(this.#size + last.length);
    let offset = 0;
    for (const part of this.#parts) {
      line.set(part, offset);
      offset += part.length;
    }
    line.set(last, offset);
    this.#parts = [];
    this.#size = 0;
    return line;
  }

  /** The line's frame, or nothing for a blank line (spaces, tabs and `\r` only). */
  #decode(bytes: Uint8Array): Frame | undefined {
    let text: string;
    try {
      text = this.#decoder.decode(bytes);
    } catch {
      return { kind: "not-utf8" };
    }
    return text.trim() === "" ? undefined : { kind: "line", text };
  }
}
