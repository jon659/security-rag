import { mkdir, writeFile, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type Doc = { doc_id: string; title: string; url: string; license: string; kind: "markdown" | "atlas-yaml"; files: string[] };

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function atlasToMarkdown(yamlText: string, title: string): string {
  const data = parseYaml(yamlText) as unknown;
  let techniques: Record<string, Record<string, unknown>> = {};

  if (Array.isArray(data)) {
    for (const t of data) {
      const id = String((t as Record<string, unknown>).id ?? "");
      if (id) techniques[id] = t as Record<string, unknown>;
    }
  } else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (obj.techniques && typeof obj.techniques === "object") {
      techniques = obj.techniques as Record<string, Record<string, unknown>>;
    } else if (obj.data && typeof obj.data === "object") {
      const dataObj = obj.data as Record<string, unknown>;
      if (dataObj.techniques && typeof dataObj.techniques === "object") {
        techniques = dataObj.techniques as Record<string, Record<string, unknown>>;
      }
    }
  }

  const parts = [`# ${title}`, ""];
  for (const [id, t] of Object.entries(techniques)) {
    const name = String(t.name ?? "");
    const desc = String(t.description ?? "").trim();
    if (!name) continue;
    const fullId = String(id);
    parts.push(`## ${fullId} ${name}`, "", desc, "");
  }
  return parts.join("\n");
}

async function main() {
  const manifest = JSON.parse(await readFile("data/corpus/manifest.json", "utf8")) as { documents: Doc[] };
  await mkdir("data/corpus", { recursive: true });
  for (const doc of manifest.documents) {
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
