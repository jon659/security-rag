import { describe, it, expect } from "vitest";
import { resolvePublicFile } from "../src/server/wire.js";

describe("resolvePublicFile", () => {
  it("finds public/index.html", () => {
    const p = resolvePublicFile("index.html");
    expect(/public[\\/]index\.html$/.test(p)).toBe(true);
  });

  it("throws for a file that does not exist", () => {
    expect(() => resolvePublicFile("does-not-exist.html")).toThrow("public file not found");
  });
});
