import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { RetrievedChunk, Vendors } from "../graph/types.js";

const GENERATE_SYSTEM = `You answer security questions using ONLY the provided sources.
Rules:
1. Use only facts present in the sources. No outside knowledge.
2. Cite sources by their numeric id in square brackets, like [12], after each claim.
3. If the sources do not contain the answer, reply with exactly: NOT_COVERED: followed by one sentence saying what the sources do cover.
4. Be concise: 3 to 8 sentences.
Return JSON only: {"answer": string, "citations": number[]} where citations lists every id you cited.`;

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
        model: cfg.generateModel, max_tokens: 700, system: GENERATE_SYSTEM,
        messages: [{ role: "user", content: `Sources:\n\n${sources}\n\nQuestion: ${question}` }],
      });
      const raw = textOf(msg);
      const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      try {
        const parsed = JSON.parse(jsonText) as { answer?: unknown; citations?: unknown };
        const answer = typeof parsed.answer === "string" ? parsed.answer : raw;
        const citations = Array.isArray(parsed.citations) ? parsed.citations.filter((n): n is number => Number.isInteger(n)) : [];
        return { answer, citations };
      } catch {
        console.log(JSON.stringify({ level: "warn", event: "generate_parse_failed", rawLength: raw.length }));
        return { answer: raw, citations: [] };
      }
    },
  };
}
