import pg from "pg";
import pgvector from "pgvector/pg";
import type { RetrievedChunk } from "../graph/types.js";

export type InsertRow = { docId: string; title: string; url: string; section: string; ordinal: number; content: string; embedding: number[] };

export type Store = {
  init(): Promise<void>;
  replaceDocument(docId: string, rows: InsertRow[]): Promise<number>;
  nearest(embedding: number[], k: number): Promise<RetrievedChunk[]>;
  count(): Promise<number>;
  close(): Promise<void>;
};

export function makeStore(databaseUrl: string): Store {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: true }, max: 3 });
  // registerTypes() queries pg_type for the "vector" OID; on a fresh database this can
  // race the `create extension if not exists vector` statement in init() and throw
  // inside this unawaited promise ("vector type not found in the database"), which
  // crashes the process as an unhandled rejection. Swallow it here: it is a best-effort
  // custom-type registration for decoding raw vector columns (none of this Store's
  // queries select one), and it succeeds on every connection made after init() has run.
  pool.on("connect", (client) => { void pgvector.registerTypes(client).catch(() => {}); });

  return {
    async init() {
      await pool.query("create extension if not exists vector");
      await pool.query(`create table if not exists chunks (
        id serial primary key,
        doc_id text not null,
        title text not null,
        url text not null,
        section text,
        ordinal int not null,
        content text not null,
        embedding vector(1024) not null
      )`);
      await pool.query("create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops)");
      await pool.query("create index if not exists chunks_doc_idx on chunks (doc_id)");
    },
    async replaceDocument(docId, rows) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("delete from chunks where doc_id = $1", [docId]);
        for (const r of rows) {
          await client.query(
            "insert into chunks (doc_id, title, url, section, ordinal, content, embedding) values ($1,$2,$3,$4,$5,$6,$7)",
            [r.docId, r.title, r.url, r.section, r.ordinal, r.content, pgvector.toSql(r.embedding)],
          );
        }
        await client.query("commit");
        return rows.length;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
    async nearest(embedding, k) {
      const res = await pool.query(
        `select id, doc_id, title, url, coalesce(section, '') as section, content,
                1 - (embedding <=> $1) as score
         from chunks order by embedding <=> $1 limit $2`,
        [pgvector.toSql(embedding), k],
      );
      return res.rows.map((r) => ({
        id: r.id, docId: r.doc_id, title: r.title, url: r.url, section: r.section, content: r.content, score: Number(r.score),
      }));
    },
    async count() {
      const res = await pool.query("select count(*)::int as n from chunks");
      return res.rows[0].n as number;
    },
    async close() { await pool.end(); },
  };
}
