import { ALLOWED_CHILDREN } from "@/lib/graph/node-types";
import type { NodeType, WorkspaceProfileAreaType } from "@/types/graph";

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

interface ExistingNodeCandidate {
  id: string;
  title: string;
  summary: string | null;
  node_type: NodeType;
}

interface ChildNodeCandidate {
  title: string;
  summary: string | null;
  node_type: NodeType;
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

const ROOT_TITLES = new Set([
  "success",
  "personal freedom",
  "life direction",
  "general",
  "personal",
  "growth",
]);

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

export function isGenericRootTitle(title: string) {
  return ROOT_TITLES.has(normalize(title).trim());
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

export function pickExistingParentForNode(params: {
  child: ChildNodeCandidate;
  existingNodes: ExistingNodeCandidate[];
}) {
  const childText = `${params.child.title}\n${params.child.summary ?? ""}`;
  const childDomains = inferDomainsFromText(childText);
  const normalizedChildTitle = normalize(params.child.title);

  const ranked = params.existingNodes
    // A guessed parent must be able to hold the child (node-types.ts). Without
    // this a new class "Statistics Midterm" was put under the big task
    // "Italian Crash Course" — the word "course" outscored everything.
    .filter((candidate) => ALLOWED_CHILDREN[candidate.node_type]?.has(params.child.node_type))
    .map((candidate) => {
      const parentText = `${candidate.title}\n${candidate.summary ?? ""}`;
      const normalizedParentTitle = normalize(candidate.title);
      let score = overlapScore(childText, parentText);

      childDomains.forEach((domain) => {
        score += keywordScore(normalizedParentTitle, domain) * 2;
      });

      if (params.child.node_type === "class") {
        if (/semester|course|courses|academics|study/.test(normalizedParentTitle)) {
          score += 7;
        }
        if (/student|honor|gpa|school/.test(normalizedParentTitle)) {
          score += 4;
        }
      }

      if (
        params.child.node_type === "task" &&
        /gym|journal|sleep|skincare/.test(normalizedChildTitle) &&
        /habit|health|wellness|routine/.test(normalizedParentTitle)
      ) {
        score += 6;
      }

      if (
        /semester|course|courses|midterm|exam|prof|reu|honor|gpa|student|school/.test(
          normalizedChildTitle,
        ) &&
        /student|academic|academics|semester|course|courses|study|honor/.test(
          normalizedParentTitle,
        )
      ) {
        score += 6;
      }

      if (
        /rent|parking|gift|birthday|renew|pay/.test(normalizedChildTitle) &&
        /admin|life/.test(normalizedParentTitle)
      ) {
        score += 6;
      }

      if (
        /project|prototype|feature|launch|marketing|pricing|billing|beta/.test(
          normalizedChildTitle,
        ) &&
        /project|product|build|launch|business|startup|saas|marketing/.test(
          normalizedParentTitle,
        )
      ) {
        score += 5;
      }

      if (candidate.node_type === "goal") {
        score += 1;
      }

      if (candidate.node_type === "area" || candidate.node_type === "project") {
        score += 1;
      }

      if (isGenericRootTitle(candidate.title)) {
        score -= 8;
      }

      return { id: candidate.id, score };
    })
    .sort((candidateA, candidateB) => candidateB.score - candidateA.score);

  if (ranked.length === 0) {
    return null;
  }

  const [best, second] = ranked;
  if (best.score < 6) {
    return null;
  }

  if (second && best.score - second.score < 2) {
    return null;
  }

  return best.id;
}
