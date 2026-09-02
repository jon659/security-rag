import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { RetrievedChunk, Vendors } from "../graph/types.js";

const GENERATE_SYSTEM = `You answer security questions using ONLY the provided sources.
Rules:
1. Use only facts present in the sources. No outside knowledge.
2. Cite sources by their numeric id in square brackets, like [12], after each claim.
3. If the sources do not contain the answer, reply with exactly: NOT_COVERED: followed by one sentence saying what the sources do cover.
4. Be concise: 3 to 8 sentences.
Respond by calling the answer tool with the answer text and the list of every id you cited.`;

const ANSWER_TOOL: Anthropic.Messages.Tool = {
  name: "answer",
  description: "Deliver the final answer and the source ids it cites.",
  input_schema: {
    type: "object",
    properties: {
      answer: { type: "string", description: "The answer text, or NOT_COVERED: followed by one sentence." },
      citations: { type: "array", items: { type: "integer" }, description: "Every source id cited in the answer." },
    },
    required: ["answer", "citations"],
  },
};

/**
 * Read the answer tool call out of a response. Exported for unit tests. A response with no
 * tool call (the model wrote prose instead) yields the prose and no citations, which the
 * graph's verify step turns into a refusal rather than an uncited answer.
 */
/** Numeric ids cited inline as [12] or [12, 15]. Exported for unit tests. */
export function citedIdsInText(text: string): number[] {
  const ids = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of m[1].split(",")) ids.add(Number(part.trim()));
  }
  return [...ids];
}

export function parseGenerateResponse(msg: Anthropic.Messages.Message): { answer: string; citations: number[] } {
  const call = msg.content.find((b) => b.type === "tool_use" && b.name === "answer");
  if (call && call.type === "tool_use") {
    const input = call.input as { answer?: unknown; citations?: unknown };
    const answer = typeof input.answer === "string" ? input.answer : "";
    let citations = Array.isArray(input.citations)
      ? input.citations.map(Number).filter((n) => Number.isInteger(n))
      : [];
    // The model sometimes cites inline ([1115]) but returns an empty list. Recover the ids
    // from the text; verify() still drops any id that was not actually retrieved.
    if (citations.length === 0) citations = citedIdsInText(answer);
    if (answer) return { answer, citations };
  }
  const raw = textOf(msg);
  console.log(JSON.stringify({ level: "warn", event: "generate_no_tool_call", stopReason: msg.stop_reason, rawLength: raw.length }));
  return { answer: raw, citations: [] };
}

const REWRITE_SYSTEM = `Rewrite the user's question as a precise search query using the vocabulary of the OWASP Top 10, the OWASP Top 10 for LLM Applications, and MITRE ATLAS. Return only the rewritten query, one line, no quotes.`;

function textOf(msg: Anthropic.Messages.Message): string {
  return msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
}

export function makeAnthropic(cfg: Config): Pick<Vendors, "rewrite" | "generate"> {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  return {
    async rewrite(question) {
      const msg = await client.messages.create({
        model: cfg.generateModel, max_tokens: 100, system: REWRITE_SYSTEM,
        messages: [{ role: "user", content: question }],
      });
      return textOf(msg) || question;
    },
    async generate(question, chunks: RetrievedChunk[]) {
      const sources = chunks.map((c) => `[${c.id}] (${c.title} / ${c.section})\n${c.content}`).join("\n\n");
      const msg = await client.messages.create({
        model: cfg.generateModel, max_tokens: 1200, system: GENERATE_SYSTEM,
        tools: [ANSWER_TOOL], tool_choice: { type: "tool", name: "answer" },
        messages: [{ role: "user", content: `Sources:\n\n${sources}\n\nQuestion: ${question}` }],
      });
      return parseGenerateResponse(msg);
    },
  };
}
