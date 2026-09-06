import { buildGraph, entityKey, resolveAliases } from "./graph.js";
import type { Entity, EntityType, ExtractionResult, Extractor, KnowledgeGraph, Relationship, SyncExtractor, TextUnit } from "./types.js";

/** Domain lexicons. Generic NER would find "June" and "Tuesday"; what an organiser
 *  needs found is the set of things that can be pressured, done, won, or spent. */
const LEXICON: { type: EntityType; terms: string[] }[] = [
  {
    type: "official",
    terms: [
      "city council", "county commission", "county commissioners court", "planning commission",
      "zoning board", "school board", "board of regents", "city manager", "mayor", "governor",
      "senator", "state representative", "attorney general", "district attorney", "sheriff",
      "police chief", "superintendent", "chancellor", "provost", "transit authority",
      "housing authority", "public utility commission", "parks department", "planning department",
      "code enforcement", "legislature", "state assembly", "congress",
    ],
  },
  {
    type: "tactic",
    terms: [
      "petition", "rally", "march", "protest", "boycott", "canvass", "door knock", "phone bank",
      "public comment", "call-in day", "teach-in", "town hall", "mutual aid", "strike", "walkout",
      "sit-in", "vigil", "letter-writing", "letter to the editor", "press conference",
      "know-your-rights training", "shareholder resolution", "picket", "sign-on letter",
    ],
  },
  {
    type: "policy",
    terms: [
      "ordinance", "resolution", "measure", "bill", "amendment", "moratorium", "rezoning",
      "zoning change", "budget", "bond", "right to counsel", "rent stabilization", "rent control",
      "inspection backlog", "permit", "variance", "environmental review", "consent decree",
      "collective bargaining agreement", "contract", "code of conduct", "curriculum",
    ],
  },
  {
    type: "resource",
    terms: [
      "childcare", "transportation", "legal observers", "legal support", "bail fund", "supplies",
      "meeting space", "translation", "printing", "sound system", "volunteers", "funding",
    ],
  },
];

const STOPWORD_STARTS = new Set([
  "we", "i", "they", "it", "the", "a", "an", "this", "that", "these", "those", "our", "their",
  "if", "when", "but", "and", "so", "then", "there", "here", "also", "however", "because",
]);

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Multi-word capitalised runs — "Austin City Council", "5th Street Lot". */
function properNouns(sentence: string, isFirstSentence: boolean): string[] {
  const out: string[] = [];
  const words = sentence.split(/\s+/);
  let run: string[] = [];

  const flush = (startedAtIndex: number) => {
    if (run.length === 0) return;
    const phrase = run.join(" ").replace(/[.,;:!?]+$/, "");
    const single = run.length === 1;
    const atSentenceStart = startedAtIndex === 0;
    // A lone capitalised word at the start of a sentence is usually just a sentence
    // start, not a name. Multi-word runs are safe; so is anything mid-sentence.
    const keep = !single || !atSentenceStart;
    if (keep && phrase.length > 2 && !STOPWORD_STARTS.has(phrase.toLowerCase())) out.push(phrase);
    run = [];
  };

  let runStart = 0;
  words.forEach((w, i) => {
    const bare = w.replace(/[^\p{L}\p{N}'-]/gu, "");
    const capitalised = /^[\p{Lu}]/u.test(bare) && bare.length > 1;
    if (capitalised && !(i === 0 && isFirstSentence && STOPWORD_STARTS.has(bare.toLowerCase()))) {
      if (run.length === 0) runStart = i;
      run.push(w);
    } else {
      flush(runStart);
    }
  });
  flush(runStart);
  return out;
}

function findLexiconTerms(lower: string): { name: string; type: EntityType }[] {
  const found: { name: string; type: EntityType }[] = [];
  for (const group of LEXICON) {
    for (const term of group.terms) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lower)) found.push({ name: term, type: group.type });
    }
  }
  return found;
}

/**
 * Deterministic, dependency-free extractor.
 *
 * This is the DEFAULT, not the fallback, and that ordering is deliberate. A self-hosted
 * instance must produce a working graph with no API key and no outbound network — an
 * organising tool whose core feature phones a third party on every statement is not a
 * tool those organisers can safely use. An LLM extractor is a drop-in `Extractor` that
 * an operator can opt into; it will find more, and it will also be a network egress
 * and a cost centre, so it should be a choice rather than an assumption.
 */
export const ruleBasedExtractor: SyncExtractor = {
  name: "rule-based",
  extract(units: readonly TextUnit[]): ExtractionResult {
    const entities: Entity[] = [];
    const relationships: Relationship[] = [];

    for (const unit of units) {
      const perUnit = new Map<string, { name: string; type: EntityType; context: string }>();
      const sentences = splitSentences(unit.text);

      sentences.forEach((sentence, si) => {
        for (const { name, type } of findLexiconTerms(sentence.toLowerCase())) {
          perUnit.set(entityKey(name, type), { name, type, context: sentence });
        }
        for (const name of properNouns(sentence, si === 0)) {
          const key = entityKey(name, "org");
          if (!perUnit.has(key)) perUnit.set(key, { name, type: "org", context: sentence });
        }
      });

      for (const [key, info] of perUnit) {
        entities.push({
          id: key,
          name: info.name,
          type: info.type,
          description: info.context.slice(0, 240),
          textUnitIds: [unit.id],
          mentions: 1,
        });
      }

      // Co-occurrence within a text unit is the relationship signal. Crude, but it is
      // the right crude: two things named in the same proposal are related in the way
      // that matters here, whatever the grammatical relation between them.
      const keys = [...perUnit.keys()];
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = keys[i]!;
          const b = keys[j]!;
          relationships.push({
            id: `${a}--${b}`,
            sourceId: a,
            targetId: b,
            description: perUnit.get(a)!.context.slice(0, 240),
            weight: 1,
            textUnitIds: [unit.id],
          });
        }
      }
    }

    return { entities, relationships };
  },
};

export async function indexCorpus(
  units: readonly TextUnit[],
  extractor: Extractor = ruleBasedExtractor,
  opts: { resolveAliases?: boolean } = {},
): Promise<KnowledgeGraph> {
  const { entities, relationships } = await extractor.extract(units);
  const graph = buildGraph(entities, relationships, units);
  return opts.resolveAliases ? resolveAliases(graph) : graph;
}
