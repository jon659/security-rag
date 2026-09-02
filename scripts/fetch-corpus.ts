import { mkdir, writeFile, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type Doc = { doc_id: string; title: string; url: string; license: string; kind: "markdown" | "atlas-yaml"; files: string[] };

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function collectTechniques(node: unknown, out: Map<string, Record<string, unknown>>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTechniques(item, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.id === "string" && obj.id.startsWith("AML.T") && typeof obj.name === "string") {
      out.set(obj.id, obj);
    }
    for (const value of Object.values(obj)) collectTechniques(value, out);
  }
}

function atlasToMarkdown(yamlText: string, title: string): string {
  const data = parseYaml(yamlText) as unknown;
  const techniques = new Map<string, Record<string, unknown>>();
  collectTechniques(data, techniques);

  const parts = [`# ${title}`, ""];
  for (const [id, t] of techniques) {
    const desc = String(t.description ?? "").trim();
    if (!desc) continue;
    parts.push(`## ${id} ${String(t.name)}`, "", desc, "");
  }
  return parts.join("\n");
}

async function main() {
  const manifest = JSON.parse(await readFile("data/corpus/manifest.json", "utf8")) as { documents: Doc[] };
  await mkdir("data/corpus", { recursive: true });
  for (const doc of manifest.documents) {
    if (doc.files.length === 0) throw new Error(`Manifest doc "${doc.doc_id}" has an empty files array`);
    let out: string;
    if (doc.kind === "markdown") {
      const bodies = [];
      for (const f of doc.files) bodies.push(await fetchText(f));
      out = `# ${doc.title}\n\n` + bodies.join("\n\n");
    } else {
      out = atlasToMarkdown(await fetchText(doc.files[0]), doc.title);
    }
    await writeFile(`data/corpus/${doc.doc_id}.md`, out, "utf8");
    console.log(`${doc.doc_id}: ${out.length} chars`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
