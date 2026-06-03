import { App, Modal, Notice, TFile } from "obsidian";
import { embed, cosine } from "../core/embedder";
import { sentencize } from "../core/nlp";
import { callLLMOnce } from "../core/llm";
import type { FypSettings } from "../settings";

const DBSCAN_EPS = 0.30;
const DBSCAN_MIN_SAMPLES = 2;
const SPLIT_SCORE_THRESHOLD = 0.6;
const MIN_SENTENCES = 4;

const sentenceEmbCache = new Map<string, number[]>();

interface SentenceUnit {
  text: string;
  headingPath: string;
  index: number;
  embedding: number[];
}

interface SplitCluster {
  sentences: SentenceUnit[];
}

export interface SplitAnalysis {
  score: number;
  clusters: SplitCluster[];
  intraSim: number;
  interSim: number;
  balance: number;
}

function segmentNote(text: string): Array<{ text: string; headingPath: string }> {
  const lines = text.split("\n");
  const headingStack: string[] = [];
  const units: Array<{ text: string; headingPath: string }> = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length - 1;
      headingStack.length = level;
      headingStack[level] = headingMatch[2].trim();
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length < 10) continue;

    const clean = trimmed
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`[^`]+`/g, "")
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "");

    if (clean.length < 10) continue;

    const headingPath = headingStack.filter(Boolean).join(" > ");
    for (const sent of sentencize(clean)) {
      units.push({ text: sent, headingPath });
    }
  }

  return units;
}

async function embedSentences(units: Array<{ text: string; headingPath: string }>): Promise<SentenceUnit[]> {
  const uncached = units.filter(u => !sentenceEmbCache.has(u.text));
  if (uncached.length > 0) {
    const embeddings = await embed(uncached.map(u => u.text));
    for (let i = 0; i < uncached.length; i++) {
      sentenceEmbCache.set(uncached[i].text, embeddings[i]);
    }
  }
  return units.map((u, i) => ({
    text: u.text,
    headingPath: u.headingPath,
    index: i,
    embedding: sentenceEmbCache.get(u.text)!,
  }));
}

function dbscan(embeddings: number[][], eps: number, minSamples: number): number[] {
  const n = embeddings.length;
  const labels = new Array<number>(n).fill(-1);
  const visited = new Set<number>();
  let clusterId = 0;

  function regionQuery(idx: number): number[] {
    const result: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== idx && 1 - cosine(embeddings[idx], embeddings[j]) <= eps) result.push(j);
    }
    return result;
  }

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    visited.add(i);
    const ns = regionQuery(i);
    if (ns.length < minSamples) continue;

    labels[i] = clusterId;
    const queue = ns.filter(j => !visited.has(j));
    while (queue.length > 0) {
      const q = queue.shift()!;
      if (!visited.has(q)) {
        visited.add(q);
        const qns = regionQuery(q);
        if (qns.length >= minSamples) {
          for (const x of qns) if (!visited.has(x)) queue.push(x);
        }
      }
      if (labels[q] === -1) labels[q] = clusterId;
    }
    clusterId++;
  }

  return labels;
}

function computeCentroid(sentences: SentenceUnit[]): number[] {
  const dim = sentences[0].embedding.length;
  const c = new Array<number>(dim).fill(0);
  for (const s of sentences) for (let d = 0; d < dim; d++) c[d] += s.embedding[d] / sentences.length;
  return c;
}

function scoreSplit(sentences: SentenceUnit[], labels: number[]): { score: number; clusters: SplitCluster[]; intraSim: number; interSim: number; balance: number } {
  const clusterMap = new Map<number, SentenceUnit[]>();
  for (let i = 0; i < sentences.length; i++) {
    const label = labels[i];
    if (label === -1) continue;
    if (!clusterMap.has(label)) clusterMap.set(label, []);
    clusterMap.get(label)!.push(sentences[i]);
  }

  const clusters: SplitCluster[] = Array.from(clusterMap.values()).map(sents => ({ sentences: sents }));
  const k = clusters.length;

  if (k < 2) return { score: 0, clusters, intraSim: 0, interSim: 0, balance: 0 };

  const centroids = clusters.map(c => computeCentroid(c.sentences));

  let intraSum = 0, intraCount = 0;
  for (const c of clusters) {
    for (let i = 0; i < c.sentences.length; i++) {
      for (let j = i + 1; j < c.sentences.length; j++) {
        intraSum += cosine(c.sentences[i].embedding, c.sentences[j].embedding);
        intraCount++;
      }
    }
  }
  const intraSim = intraCount > 0 ? intraSum / intraCount : 1;

  let interSum = 0, interCount = 0;
  for (let i = 0; i < centroids.length; i++) {
    for (let j = i + 1; j < centroids.length; j++) {
      interSum += cosine(centroids[i], centroids[j]);
      interCount++;
    }
  }
  const interSim = interCount > 0 ? interSum / interCount : 0;

  const sizes = clusters.map(c => c.sentences.length);
  const balance = Math.min(...sizes) / Math.max(...sizes);
  const simGap = Math.max(0, intraSim - interSim);
  const score = 0.4 * simGap + 0.3 * balance + 0.3 * Math.min(k / 4, 1);

  return { score, clusters, intraSim, interSim, balance };
}

export async function analyseSplit(text: string): Promise<SplitAnalysis | null> {
  const rawUnits = segmentNote(text);
  if (rawUnits.length < MIN_SENTENCES) return null;

  const sentences = await embedSentences(rawUnits);
  const labels = dbscan(sentences.map(s => s.embedding), DBSCAN_EPS, DBSCAN_MIN_SAMPLES);
  const { score, clusters, intraSim, interSim, balance } = scoreSplit(sentences, labels);

  if (clusters.length < 2 || score < SPLIT_SCORE_THRESHOLD) return null;

  return { score, clusters, intraSim, interSim, balance };
}

interface ProposedSplit {
  original: { title: string; content: string };
  new_notes: Array<{ title: string; content: string }>;
}

async function requestLLMSplit(noteContent: string, settings: FypSettings): Promise<ProposedSplit> {
  const prompt = `You are splitting a note that contains multiple distinct topics into separate focused notes.

Here is the full note content:
\`\`\`markdown
${noteContent}
\`\`\`

Split this note into separate notes — one per topic. Output a JSON object inside a \`\`\`json code block with this exact structure:
{
  "original": { "title": "...", "content": "..." },
  "new_notes": [
    { "title": "...", "content": "..." }
  ]
}

Rules:
- "original" is the revised version of the current note (its main topic)
- "new_notes" contains the spun-off notes
- Preserve all content — just reorganise it
- Each note gets a concise title and complete markdown content
- Use proper markdown headings in content`;

  const raw = await callLLMOnce(
    [{ role: "user", content: prompt }],
    settings,
  );

  const jsonMatch = raw.match(/```json\s*([\s\S]+?)```/);
  if (!jsonMatch) throw new Error("LLM did not return a JSON code block.");
  return JSON.parse(jsonMatch[1]) as ProposedSplit;
}

export class NoteSplitModal extends Modal {
  private file: TFile;
  private analysis: SplitAnalysis;
  private settings: FypSettings;

  constructor(app: App, file: TFile, analysis: SplitAnalysis, settings: FypSettings) {
    super(app);
    this.file = file;
    this.analysis = analysis;
    this.settings = settings;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Note split suggestion" });
    contentEl.createEl("p", {
      cls: "fyp-modal-desc",
      text: `"${this.file.basename}" appears to contain ${this.analysis.clusters.length} distinct topics (score ${this.analysis.score.toFixed(2)}).`,
    });

    for (let i = 0; i < this.analysis.clusters.length; i++) {
      const c = this.analysis.clusters[i];
      const card = contentEl.createEl("div", { cls: "fyp-split-card" });
      card.createEl("strong", { text: `Topic ${i + 1} (${c.sentences.length} sentences)` });
      const preview = c.sentences.slice(0, 2).map(s => s.text).join(" ");
      card.createEl("p", { text: preview.slice(0, 200) + (preview.length > 200 ? "…" : "") });
    }

    const btnRow = contentEl.createEl("div", { cls: "fyp-btn-row" });
    const splitBtn = btnRow.createEl("button", { text: "Split with AI", cls: "mod-cta" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });

    splitBtn.addEventListener("click", async () => {
      splitBtn.disabled = true;
      splitBtn.setText("Splitting…");
      try {
        await this.doSplit();
        this.close();
      } catch (e) {
        new Notice(`Split failed: ${(e as Error).message}`);
        splitBtn.disabled = false;
        splitBtn.setText("Split with AI");
      }
    });
    cancelBtn.addEventListener("click", () => this.close());
  }

  private async doSplit(): Promise<void> {
    const content = await this.app.vault.read(this.file);
    const proposed = await requestLLMSplit(content, this.settings);

    await this.app.vault.modify(this.file, proposed.original.content);

    const folder = this.file.parent?.path ?? "";
    const prefix = folder && folder !== "/" ? `${folder}/` : "";

    for (const note of proposed.new_notes) {
      const safeName = note.title.replace(/[\\/:*?"<>|]/g, "_");
      const path = `${prefix}${safeName}.md`;
      try {
        await this.app.vault.create(path, note.content);
      } catch {
        await this.app.vault.create(`${prefix}${safeName}_split.md`, note.content);
      }
    }

    new Notice(`Split into ${1 + proposed.new_notes.length} notes.`);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
