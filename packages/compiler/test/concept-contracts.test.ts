// The contracts concepts rest on (notes/architecture/concepts-design.md, sections 3.2 and 6; ruling D36).
//
// The four field parents (`attributes`, `event`, `command`, `concept`) list no `children` (OD3): a concept use
// (`Money :total`) is a tag MX finds in a `concepts` folder, whose name no contract can list in advance. Each field kind's
// `parents` keeps a misplaced known line an error, now `MESH_PARENT_NOT_ALLOWED`, and MX keeps a tagless `&title` one, now
// `MESH_UNKNOWN_TAG`. The legal neighbours stay legal.
import { lowerSource } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

const FILE = "/v/todo.mesh.mx";
const said = (source: string) =>
  lowerSource(source, FILE, { dialect: MESH_DIALECT }).diagnostics.map((d) => `${d.line}:${d.column} ${d.code} ${d.message}`);

const ENTITY = (lines: string) => `entity :T\n  attributes\n    uuid :id primary-key\n${lines}`;

describe("the field parents are open (OD3)", () => {
  test.each([
    ["attributes", ENTITY("    &title\n"), "4:4"],
    ["event", "event :E\n  uuid :id\n  &title\n", "3:2"],
    ["command", "command :C\n  uuid :id\n  &title\n", "3:2"],
    ["concept", "concept :Money\n  integer :amount\n  &title\n", "3:2"],
  ])("a tagless `&title` under %s is MESH_UNKNOWN_TAG once", (_, source, at) => {
    expect(said(source)).toEqual([`${at} MESH_UNKNOWN_TAG \`&title\` is not a known tag in the \`mesh\` dialect`]);
  });

  test.each([
    ["`check` under attributes", ENTITY("    check that=() => true\n"), "4:4 MESH_PARENT_NOT_ALLOWED `check` must be inside `validate`, `when`, `checks`; found inside `attributes`"],
    ["`belongs-to` in an event", "event :E\n  belongs-to :x entity=E\n", "2:2 MESH_PARENT_NOT_ALLOWED `belongs-to` must be inside `relationships`; found inside `event`"],
    ["`actions` in a command", "command :C\n  actions\n", "2:2 MESH_PARENT_NOT_ALLOWED `actions` must be inside `entity`; found inside `command`"],
    ["`belongs-to` in a concept", "concept :Money\n  belongs-to :x entity=E\n", "2:2 MESH_PARENT_NOT_ALLOWED `belongs-to` must be inside `relationships`; found inside `concept`"],
    ["a `concept` line below the top", ENTITY("  concept :Money\n    integer :x\n"), "4:2 MESH_TAG_NOT_ALLOWED `entity`: `concept` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies`, `events`, `commands`"],
  ])("%s is refused by the line's parents or its parent's children", (_, source, message) => {
    expect(said(source)).toEqual([message]);
  });

  test("MX no longer stops at the first misplaced line: each is reported", () => {
    expect(said(ENTITY("    belongs-to :a entity=T\n    check that=() => true\n    has-many :b entity=T\n")).map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "4:4 MESH_PARENT_NOT_ALLOWED",
      "5:4 MESH_PARENT_NOT_ALLOWED",
      "6:4 MESH_PARENT_NOT_ALLOWED",
    ]);
  });

  test("an unknown head under a field parent is MX's unknown tag, as it was", () => {
    expect(said(ENTITY("    Nope :x\n"))).toEqual(["4:4 MESH_UNKNOWN_TAG `Nope` is not a known tag in the `mesh` dialect"]);
  });

  test("the legal neighbours stay legal: every field kind under each field parent, `&title` under `input`", () => {
    expect(said(ENTITY("    string :title\n    enum :state values=[:a, :b]\n    json :data\n  actions\n    create :open\n      input\n        &title\n"))).toEqual([]);
    expect(said("event :E\n  uuid :id\n  string :note nullable\n")).toEqual([]);
    expect(said("command :C\n  uuid :id\n  integer :n optional\n")).toEqual([]);
    // A concept file is a root of its own whose field lines are written as an event's.
    expect(said("concept :Money\n  string :currency match=/^[A-Z]{3}$/\n  integer :amount min=0 max=10\n  enum :kind values=[:a, :b] nullable\n  json :extra\n")).toEqual([]);
  });

  test("`input` and `computed` stay closed: a misplaced line there is still MESH_TAG_NOT_ALLOWED", () => {
    expect(said(ENTITY("  computed\n    belongs-to :x entity=T\n")).map((line) => line.split(" ").slice(1, 2)[0])).toEqual(["MESH_TAG_NOT_ALLOWED"]);
    expect(said(ENTITY("  actions\n    create :open\n      input\n        check that=() => true\n")).map((line) => line.split(" ").slice(1, 2)[0])).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });
});
