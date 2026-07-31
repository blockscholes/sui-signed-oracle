// Pins the generator to the committed artifact. `move/bs_sid/vectors.json` is
// what `bs_sid::sid_tests` and websocketAPI's CI pin against, so an edit that
// moves any byte of it must fail here first: re-pinning every consumer is a
// coordinated act, never a drive-by.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { build, render } from "./generate_sid_vectors.js";

describe("generate_sid_vectors", () => {
  it("reproduces the committed vectors.json byte-for-byte", () => {
    const committed = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../move/bs_sid/vectors.json"),
      "utf8",
    );
    expect(render(build())).toBe(committed);
  });
});
