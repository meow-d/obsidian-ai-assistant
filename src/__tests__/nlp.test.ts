import { describe, it, expect } from "vitest";
import { extractCandidates, getLinkedPhrases } from "../core/nlp";

describe("getLinkedPhrases", () => {
  it("extracts target from a simple wikilink", () => {
    const result = getLinkedPhrases("See [[Knowledge Management]] for details.");
    expect(result.has("knowledge management")).toBe(true);
  });

  it("uses alias when present, not target", () => {
    const result = getLinkedPhrases("Read [[PKM|personal knowledge management]].");
    expect(result.has("personal knowledge management")).toBe(true);
    expect(result.has("pkm")).toBe(false);
  });

  it("handles multiple wikilinks", () => {
    const result = getLinkedPhrases("[[Zettelkasten]] and [[Roam Research|Roam]]");
    expect(result.has("zettelkasten")).toBe(true);
    expect(result.has("roam")).toBe(true);
  });

  it("returns empty set when there are no wikilinks", () => {
    expect(getLinkedPhrases("No links here.").size).toBe(0);
  });

  it("lowercases all entries", () => {
    const result = getLinkedPhrases("[[MixedCase]]");
    expect(result.has("mixedcase")).toBe(true);
    expect(result.has("MixedCase")).toBe(false);
  });
});

describe("extractCandidates", () => {
  it("returns an array", () => {
    const result = extractCandidates("Marie Curie discovered radioactivity in Paris.");
    expect(Array.isArray(result)).toBe(true);
  });

  it("strips wikilinks before NLP so linked phrases are not returned", () => {
    const result = extractCandidates("See [[Marie Curie]] for her work.");
    expect(result.map((s) => s.toLowerCase())).not.toContain("marie curie");
  });

  it("strips markdown headings", () => {
    const result = extractCandidates("## Introduction\nSome text.");
    expect(result).not.toContain("Introduction");
  });

  it("strips inline code", () => {
    const result = extractCandidates("Use `parseSSELine` to handle events.");
    expect(result).not.toContain("parseSSELine");
  });

  it("strips fenced code blocks", () => {
    const result = extractCandidates("```python\nfoo_bar = 1\n```");
    expect(result).not.toContain("foo_bar");
  });

  it("filters stop words", () => {
    const result = extractCandidates("The quick brown fox jumps over the lazy dog.");
    const lower = result.map((s) => s.toLowerCase());
    for (const stop of ["the", "over"]) {
      expect(lower).not.toContain(stop);
    }
  });

  it("filters tokens shorter than 3 characters", () => {
    const result = extractCandidates("Go is a programming language.");
    for (const c of result) {
      // normalize to just word chars and check length
      const word = c.replace(/[^\w]/g, "");
      expect(word.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("does not return duplicates", () => {
    const result = extractCandidates("Knowledge graphs. Knowledge graphs are important.");
    const normalized = result.map((s) => s.toLowerCase());
    const unique = new Set(normalized);
    expect(normalized.length).toBe(unique.size);
  });
});
