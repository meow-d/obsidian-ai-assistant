import winkNLP, { type ItemEntity } from "wink-nlp";
import winkModel from "wink-eng-lite-web-model";

const nlp = winkNLP(winkModel);
const its = nlp.its;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its",
  "i", "you", "we", "they", "he", "she", "me", "him", "her", "us", "them",
  "my", "your", "our", "their", "his", "her", "also", "not", "no", "if",
  "as", "so", "then", "than", "which", "who", "what", "when", "where",
  "how", "all", "any", "each", "more", "most", "some", "such", "other",
  "new", "just", "one", "two", "first", "last", "use", "used", "can", "very",
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").trim();
}

function isUseful(s: string): boolean {
  if (s.length < 3) return false;
  const norm = normalize(s);
  if (STOP_WORDS.has(norm)) return false;
  // skip pure numbers
  if (/^\d+$/.test(norm)) return false;
  return true;
}

/** Extract named entities and significant noun phrases from markdown text. */
export function extractCandidates(text: string): string[] {
  // strip wikilinks and markdown syntax before NLP so they don't pollute results
  const clean = text
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "") // remove wikilinks
    .replace(/^#+\s.*/gm, "")                         // remove headings
    .replace(/`[^`]+`/g, "")                          // remove inline code
    .replace(/```[\s\S]*?```/g, "")                   // remove code blocks
    .replace(/!\[.*?\]\(.*?\)/g, "")                  // remove images
    .replace(/\[.*?\]\(.*?\)/g, "");                  // remove md links

  const doc = nlp.readDoc(clean);
  const seen = new Set<string>();
  const candidates: string[] = [];

  function add(s: string) {
    const k = normalize(s);
    if (!seen.has(k) && isUseful(s)) {
      seen.add(k);
      candidates.push(s.trim());
    }
  }

  // Named entities
  doc.entities().each((e: ItemEntity) => add(e.out(its.value)));

  // Build multi-word noun phrases from consecutive PROPN/NOUN tokens
  const tokens = doc.tokens().out(its.value);
  const posTags = doc.tokens().out(its.pos);

  let phraseStart = -1;
  for (let i = 0; i < tokens.length; i++) {
    const isNounLike = posTags[i] === "NOUN" || posTags[i] === "PROPN" || posTags[i] === "ADJ";
    if (isNounLike) {
      if (phraseStart === -1) phraseStart = i;
    } else {
      if (phraseStart !== -1) {
        const phrase = tokens.slice(phraseStart, i).join(" ");
        if (phrase.split(" ").length > 1) add(phrase); // only multi-word
        else add(tokens[phraseStart] as string);          // single noun if it passes isUseful
        phraseStart = -1;
      }
    }
  }
  if (phraseStart !== -1) {
    const phrase = tokens.slice(phraseStart).join(" ");
    add(phrase);
  }

  return candidates;
}

/** Split text into sentences using winkNLP. */
export function sentencize(text: string): string[] {
  const doc = nlp.readDoc(text);
  const out: string[] = [];
  doc.sentences().each((s: any) => {
    const t = (s.out(its.value) as string).trim();
    if (t.length >= 10) out.push(t);
  });
  return out;
}

/** Get the set of phrases already wikilinked in text. */
export function getLinkedPhrases(text: string): Set<string> {
  const linked = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    linked.add((m[2] ?? m[1]).toLowerCase());
  }
  return linked;
}
