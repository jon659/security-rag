import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { parseGenerateResponse, citedIdsInText } from "../src/vendors/anthropic.js";

const msg = (content: unknown[]): Anthropic.Messages.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: "tool_use", stop_sequence: null, usage: {} }) as unknown as Anthropic.Messages.Message;

describe("parseGenerateResponse", () => {
  it("reads the answer tool call", () => {
    const r = parseGenerateResponse(msg([{ type: "tool_use", id: "t", name: "answer", input: { answer: "A [3].", citations: [3, "7"] } }]));
    expect(r).toEqual({ answer: "A [3].", citations: [3, 7] });
  });
  it("falls back to prose with no citations when the model did not call the tool", () => {
    const r = parseGenerateResponse(msg([{ type: "text", text: "Just prose." }]));
    expect(r).toEqual({ answer: "Just prose.", citations: [] });
  });
  it("passes NOT_COVERED through for the verify step", () => {
    const r = parseGenerateResponse(msg([{ type: "tool_use", id: "t", name: "answer", input: { answer: "NOT_COVERED: only injection.", citations: [] } }]));
    expect(r.answer.startsWith("NOT_COVERED:")).toBe(true);
  });
});

describe("citedIdsInText", () => {
  it("recovers inline ids, including comma lists, without duplicates", () => {
    expect(citedIdsInText("A [1115]. B [1117, 1046]. C [1115].")).toEqual([1115, 1117, 1046]);
    expect(citedIdsInText("no citations here")).toEqual([]);
  });
  it("is used when the tool call's citations list is empty", () => {
    const r = parseGenerateResponse(msg([{ type: "tool_use", id: "t", name: "answer", input: { answer: "Insecure design [1115] means [1117].", citations: [] } }]));
    expect(r.citations).toEqual([1115, 1117]);
  });
});
