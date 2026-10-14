import { describe, expect, test } from "bun:test";
import { LineReader, type Frame } from "../src/framing.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const texts = (frames: Frame[]) => frames.map((frame) => (frame.kind === "line" ? frame.text : frame.kind));

describe("LineReader", () => {
  test("a chunk holding two lines yields both, in order", () => {
    const reader = new LineReader(1024);
    expect(texts(reader.push(bytes('{"a":1}\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("a line split across three chunks, inside a multi-byte character, is decoded whole", () => {
    const reader = new LineReader(1024);
    const line = bytes('{"name":"café €"}\n');
    // Cut inside the two bytes of "é" and inside the three bytes of "€".
    const e = line.indexOf(0xc3) + 1;
    const euro = line.indexOf(0xe2) + 2;
    expect(reader.push(line.subarray(0, e))).toEqual([]);
    expect(reader.push(line.subarray(e, euro))).toEqual([]);
    expect(texts(reader.push(line.subarray(euro)))).toEqual(['{"name":"café €"}']);
  });

  test("the bytes of an unfinished line are copied, so a chunk reused by the socket does not change them", () => {
    const reader = new LineReader(1024);
    const chunk = bytes('{"a":');
    reader.push(chunk);
    chunk.fill(0x20);
    expect(texts(reader.push(bytes("1}\n")))).toEqual(['{"a":1}']);
  });

  test("a trailing \\r is kept for the JSON parser, and blank lines yield nothing", () => {
    const reader = new LineReader(1024);
    expect(texts(reader.push(bytes('\n\r\n   \n\t\r\n{"a":1}\r\n\n')))).toEqual(['{"a":1}\r']);
  });

  test("a line of exactly the limit is accepted; one byte more is too long", () => {
    const reader = new LineReader(8);
    expect(texts(reader.push(bytes("12345678\n123456789\nok\n")))).toEqual(["12345678", "too-long", "ok"]);
  });

  test("an over-long line spread over many chunks yields one too-long frame, and the next line is read", () => {
    const reader = new LineReader(8);
    const frames = [
      ...reader.push(bytes("1234")),
      ...reader.push(bytes("56789")),
      ...reader.push(bytes("abcdefghij")),
      ...reader.push(bytes("klm\nnext\n")),
    ];
    expect(texts(frames)).toEqual(["too-long", "next"]);
  });

  test("an over-long line that ends in the chunk that overflows does not swallow the next line", () => {
    const reader = new LineReader(4);
    expect(texts(reader.push(bytes("12")))).toEqual([]);
    expect(texts(reader.push(bytes("345\nab\n")))).toEqual(["too-long", "ab"]);
  });

  test("a line that is not valid UTF-8 is reported as such, and the stream goes on", () => {
    const reader = new LineReader(1024);
    const frames = reader.push(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a, ...bytes('{"a":1}\n')]));
    expect(texts(frames)).toEqual(["not-utf8", '{"a":1}']);
  });

  test("a final line with no newline yields nothing", () => {
    const reader = new LineReader(1024);
    expect(reader.push(bytes('{"a":1}'))).toEqual([]);
  });
});
