export type RetrievedDocument = {
  content: string;
  id: string;
  label: string;
  title: string;
  type: "sop" | "capture";
};

export type RetrievalCandidate = RetrievedDocument & {
  createdAt: Date | null;
};

const STOP_WORDS = new Set([
  "after",
  "and",
  "are",
  "before",
  "can",
  "check",
  "for",
  "from",
  "how",
  "into",
  "machine",
  "the",
  "this",
  "that",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter((token) => token.length >= 3 && !STOP_WORDS.has(token)) ?? [],
    ),
  ];
}

function termsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  // A tiny prefix stem handles factory phrasing such as vibration/vibrates without
  // pretending this 20-document prototype needs a search engine or embeddings.
  return left.length >= 5 && right.length >= 5 && left.slice(0, 5) === right.slice(0, 5);
}

function matchingTermCount(queryTerms: string[], text: string): number {
  const textTerms = tokens(text);
  return queryTerms.filter((queryTerm) =>
    textTerms.some((textTerm) => termsMatch(queryTerm, textTerm)),
  ).length;
}

function relevance(
  document: RetrievalCandidate,
  queryTerms: string[],
  relatedTerms: string[],
): number {
  const primary =
    matchingTermCount(queryTerms, document.title) * 4 +
    matchingTermCount(queryTerms, document.content);
  const related =
    matchingTermCount(relatedTerms, document.title) * 0.75 +
    matchingTermCount(relatedTerms, document.content) * 0.25;
  const captureTieBreak = document.type === "capture" && primary + related > 0 ? 0.1 : 0;
  return primary + related + captureTieBreak;
}

export function rankDocuments(
  question: string,
  machineId: string,
  candidates: RetrievalCandidate[],
  limit = 6,
): RetrievedDocument[] {
  const machineTerms = new Set(tokens(machineId));
  const queryTerms = tokens(question).filter((term) => !machineTerms.has(term));
  if (queryTerms.length === 0) {
    return [];
  }

  const rankedSops = candidates
    .filter((candidate) => candidate.type === "sop")
    .map((candidate) => ({
      candidate,
      score: relevance(candidate, queryTerms, []),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);

  // Expand only from the best matching SOP titles. This remains transparent
  // keyword retrieval, while allowing an approved field capture about a bearing
  // or coolant check to join a broader question phrased only as "vibration".
  const relatedTerms = [
    ...new Set(
      rankedSops
        .slice(0, 1)
        .flatMap(({ candidate }) => tokens(`${candidate.title}\n${candidate.content}`))
        .filter(
          (term) =>
            !queryTerms.some((queryTerm) => termsMatch(term, queryTerm)) &&
            !machineTerms.has(term),
        ),
    ),
  ];

  return candidates
    .map((candidate) => ({
      candidate,
      score: relevance(
        candidate,
        queryTerms,
        candidate.type === "capture" ? relatedTerms : [],
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.candidate.type !== right.candidate.type) {
        return left.candidate.type === "capture" ? -1 : 1;
      }
      return (
        (right.candidate.createdAt?.getTime() ?? 0) -
        (left.candidate.createdAt?.getTime() ?? 0)
      );
    })
    .slice(0, limit)
    .map(({ candidate: { createdAt: _createdAt, ...document } }) => document);
}
