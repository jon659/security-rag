import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  COHERE_API_KEY: z.string().min(1, "COHERE_API_KEY is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  EMBED_MODEL: z.string().default("embed-v4.0"),
  RERANK_MODEL: z.string().default("rerank-v3.5"),
  GENERATE_MODEL: z.string().default("claude-sonnet-5"),
});

export type Config = {
  cohereApiKey: string;
  anthropicApiKey: string;
  databaseUrl: string;
  relevanceThreshold: number;
  embedModel: string;
  rerankModel: string;
  generateModel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}`);
  }
  const e = parsed.data;
  return {
    cohereApiKey: e.COHERE_API_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    databaseUrl: e.DATABASE_URL,
    relevanceThreshold: e.RELEVANCE_THRESHOLD,
    embedModel: e.EMBED_MODEL,
    rerankModel: e.RERANK_MODEL,
    generateModel: e.GENERATE_MODEL,
  };
}
