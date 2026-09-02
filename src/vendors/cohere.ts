import { CohereClientV2 } from "cohere-ai";
import type { Config } from "../config.js";
import type { Vendors } from "../graph/types.js";

export function makeCohere(cfg: Config): Pick<Vendors, "embedQuery" | "embedDocuments" | "rerank"> {
  const client = new CohereClientV2({ token: cfg.cohereApiKey });

  async function embed(texts: string[], inputType: "search_query" | "search_document"): Promise<number[][]> {
    const res = await client.embed({
      model: cfg.embedModel,
      texts,
      inputType,
      embeddingTypes: ["float"],
      outputDimension: 1024,
    });
    const vectors = res.embeddings?.float;
    if (!vectors || vectors.length !== texts.length) throw new Error("Cohere embed returned an unexpected shape");
    return vectors;
  }

  return {
    embedQuery: async (text) => (await embed([text], "search_query"))[0],
    embedDocuments: async (texts) => {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 96) out.push(...(await embed(texts.slice(i, i + 96), "search_document")));
      return out;
    },
    rerank: async (query, docs, topN) => {
      const res = await client.rerank({
        model: cfg.rerankModel,
        query,
        documents: docs.map((d) => d.text),
        topN,
      });
      return res.results.map((r) => ({ id: docs[r.index].id, score: r.relevanceScore }));
    },
  };
}
