import type { WorkspaceProfileAreaType } from "@/types/graph";

type Domain =
  | "academic"
  | "health"
  | "finance"
  | "career"
  | "project"
  | "life_admin"
  | "personal";

interface GoalCandidate {
  id: string;
  title: string;
}

const DOMAIN_KEYWORDS: Record<Domain, string[]> = {
  academic: [
    "academic",
    "academics",
    "class",
    "classes",
    "course",
    "courses",
    "semester",
    "study",
    "student",
    "school",
    "honor",
    "honours",
    "gpa",
    "midterm",
    "exam",
    "assignment",
    "prof",
    "reu",
    "grad",
    "research",
    "ml",
    "stats",
    "linear algebra",
  ],
  health: [
    "health",
    "healthy",
    "habit",
    "habits",
    "routine",
    "routines",
    "wellness",
    "gym",
    "fitness",
    "journal",
    "journaling",
    "sleep",
    "skincare",
    "self improvement",
    "exercise",
  ],
  finance: [
    "finance",
    "financial",
    "money",
    "income",
    "independent",
    "independence",
    "freedom",
    "pricing",
    "billing",
    "stripe",
    "runway",
    "llc",
  ],
  career: [
    "career",
    "job",
    "work",
    "day job",
    "performance review",
    "tech lead",
    "promotion",
    "resume",
    "internship",
  ],
  project: [
    "project",
    "build",
    "launch",
    "startup",
    "saas",
    "product",
    "mvp",
    "feature",
    "prototype",
    "beta",
    "marketing",
    "landing page",
  ],
  life_admin: [
    "admin",
    "rent",
    "parking",
    "gift",
    "birthday",
    "renew",
    "pay",
    "bill",
    "life",
  ],
  personal: ["personal", "family", "home", "systems", "life"],
};

function normalize(text: string | null | undefined) {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function tokenize(text: string | null | undefined) {
  return normalize(text)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function includesPhrase(text: string, phrase: string) {
  return text.includes(phrase.toLowerCase());
}

function inferDomainsFromText(text: string | null | undefined) {
  const normalized = normalize(text);
  const domains = new Set<Domain>();

  (Object.keys(DOMAIN_KEYWORDS) as Domain[]).forEach((domain) => {
    if (DOMAIN_KEYWORDS[domain].some((keyword) => includesPhrase(normalized, keyword))) {
      domains.add(domain);
    }
  });

  return domains;
}

function keywordScore(text: string, domain: Domain) {
  return DOMAIN_KEYWORDS[domain].reduce((score, keyword) => {
    return score + (includesPhrase(text, keyword) ? (keyword.includes(" ") ? 2 : 1) : 0);
  }, 0);
}

function overlapScore(childText: string, parentText: string) {
  const childTokens = new Set(tokenize(childText));
  const parentTokens = tokenize(parentText);
  let score = 0;

  parentTokens.forEach((token) => {
    if (childTokens.has(token)) {
      score += 1;
    }
  });

  return Math.min(score, 4);
}

export function pickGoalForArea(params: {
  areaTitle: string;
  areaType: WorkspaceProfileAreaType;
  goals: GoalCandidate[];
}) {
  if (params.goals.length === 0) {
    return null;
  }

  const areaText = normalize(params.areaTitle);
  const inferredDomains = inferDomainsFromText(params.areaTitle);
  inferredDomains.add(params.areaType);

  const ranked = params.goals
    .map((goal) => {
      const goalText = normalize(goal.title);
      let score = overlapScore(areaText, goalText);

      inferredDomains.forEach((domain) => {
        score += keywordScore(goalText, domain);
      });

      if (params.areaType === "academic" && /student|honor|gpa|study|school|grad/.test(goalText)) {
        score += 5;
      }

      if (params.areaType === "health" && /habit|health|wellness|fitness|routine/.test(goalText)) {
        score += 5;
      }

      if (
        (params.areaType === "career" || params.areaType === "project") &&
        /career|money|financial|launch|build|business|product/.test(goalText)
      ) {
        score += 4;
      }

      if (
        params.areaType === "life_admin" &&
        /systems|stable|organized|habit|life/.test(goalText)
      ) {
        score += 2;
      }

      return { goalId: goal.id, score };
    })
    .sort((goalA, goalB) => goalB.score - goalA.score);

  if (ranked.length === 0) {
    return null;
  }

  const [best, second] = ranked;
  if (best.score < 4) {
    return null;
  }

  if (second && best.score - second.score < 2) {
    return null;
  }

  return best.goalId;
}
