import type {
  ChatMessage,
  ChatMessageSection,
  ChatNodeContext,
  ChatScope,
} from "@/types/chat";

const workspaceSnapshot = {
  majorNodes: ["Neurolight", "Probability 2", "Data Sources", "Paper Ideas"],
  bridgeNodes: ["Probability 2", "Research Notes"],
  underdevelopedAreas: ["Paper Ideas", "Email Professor"],
};

function createId() {
  return `chat-${Math.random().toString(36).slice(2, 10)}`;
}

function inferWorkspaceReply(message: string): { body: string; sections: ChatMessageSection[] } {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("important") ||
    normalized.includes("focus") ||
    normalized.includes("next")
  ) {
    return {
      body: "The strongest immediate thread is Neurolight supported by Probability 2 and Data Sources.",
      sections: [
        {
          label: "Reason",
          value:
            "That chain is the clearest path from academic grounding into project execution.",
        },
        {
          label: "Related nodes",
          value: workspaceSnapshot.majorNodes.slice(0, 3).join(", "),
        },
        {
          label: "Possible action",
          value: "Tighten the prototype path before expanding into new peripheral ideas.",
        },
      ],
    };
  }

  if (
    normalized.includes("connect") ||
    normalized.includes("linked") ||
    normalized.includes("relationship")
  ) {
    return {
      body: "The graph currently has one strong academic-to-project bridge and a weaker idea layer around it.",
      sections: [
        {
          label: "Bridge",
          value: `${workspaceSnapshot.bridgeNodes[0]} is the clearest bridge into project work.`,
        },
        {
          label: "Weak area",
          value: `${workspaceSnapshot.underdevelopedAreas[0]} still needs firmer links and supporting evidence.`,
        },
      ],
    };
  }

  if (
    normalized.includes("underdeveloped") ||
    normalized.includes("missing") ||
    normalized.includes("gap")
  ) {
    return {
      body: "The workspace looks thinnest where ideas exist without execution or evidence attached to them.",
      sections: [
        {
          label: "Thin areas",
          value: workspaceSnapshot.underdevelopedAreas.join(", "),
        },
        {
          label: "Possible action",
          value: "Add supporting notes, dependencies, or next actions before creating more new branches.",
        },
      ],
    };
  }

  return {
    body: "At workspace scope, I can reason about priorities, weak areas, and how the major nodes connect.",
    sections: [
      {
        label: "Current center",
        value: workspaceSnapshot.majorNodes.slice(0, 2).join(", "),
      },
      {
        label: "Ask next",
        value: "Try asking what matters most, what is underdeveloped, or what should be linked next.",
      },
    ],
  };
}

function inferNodeReply(
  message: string,
  node: ChatNodeContext,
): { body: string; sections: ChatMessageSection[] } {
  const normalized = message.toLowerCase();
  const relatedNodes =
    node.connectedNodeTitles.length > 0 ? node.connectedNodeTitles.join(", ") : "No linked nodes yet";
  const edgeSummary =
    node.edgeTypes.length > 0
      ? node.edgeTypes.map((edgeType) => edgeType.replaceAll("_", " ")).join(", ")
      : "No link metadata yet";

  if (
    (normalized.includes("why") && normalized.includes("link")) ||
    normalized.includes("linked")
  ) {
    return {
      body: `${node.title} is linked because it sits on a useful path through the current graph, not just because it sounds similar.`,
      sections: [
        {
          label: "Reason",
          value:
            node.summary ??
            `${node.title} carries a clear role in the graph as a ${node.node_type}.`,
        },
        {
          label: "Related nodes",
          value: relatedNodes,
        },
        {
          label: "Edge types",
          value: edgeSummary,
        },
      ],
    };
  }

  if (normalized.includes("merge")) {
    return {
      body: `I would not merge ${node.title} unless another node duplicates both its role and its evidence.`,
      sections: [
        {
          label: "Check first",
          value: "Compare title overlap, summary overlap, and whether the links serve the same downstream work.",
        },
        {
          label: "Safer action",
          value: "Keep the node separate and tighten its summary or links before collapsing structure.",
        },
      ],
    };
  }

  if (
    normalized.includes("support") ||
    normalized.includes("missing") ||
    normalized.includes("improve")
  ) {
    return {
      body: `${node.title} would improve most from clearer support and one stronger next action.`,
      sections: [
        {
          label: "Current support",
          value: relatedNodes,
        },
        {
          label: "Missing",
          value: "Evidence, sharper summary language, or one explicit downstream action.",
        },
      ],
    };
  }

  return {
    body: `I’m treating ${node.title} as the current reference point for this conversation.`,
    sections: [
      {
        label: "Type",
        value: node.node_type,
      },
      {
        label: "Importance",
        value: `${node.importance} · ${node.importanceIndex}`,
      },
      {
        label: "Related nodes",
        value: relatedNodes,
      },
    ],
  };
}

export function createWorkspaceScope(workspaceName: string): ChatScope {
  return {
    kind: "workspace",
    workspaceName,
  };
}

export function createNodeScope(
  workspaceName: string,
  node: ChatNodeContext,
): ChatScope {
  return {
    kind: "node",
    workspaceName,
    node,
  };
}

export function createUserChatMessage(body: string): ChatMessage {
  return {
    id: createId(),
    role: "user",
    body,
    createdAt: new Date().toISOString(),
  };
}

export function createAssistantChatMessage(
  body: string,
  sections: ChatMessageSection[],
): ChatMessage {
  return {
    id: createId(),
    role: "assistant",
    body,
    createdAt: new Date().toISOString(),
    sections,
    status: "ready",
  };
}

export function createErrorChatMessage(body: string): ChatMessage {
  return {
    id: createId(),
    role: "assistant",
    body,
    createdAt: new Date().toISOString(),
    status: "error",
  };
}

export function createAssistantReply(
  message: string,
  scope: ChatScope,
): ChatMessage {
  const reply =
    scope.kind === "node"
      ? inferNodeReply(message, scope.node)
      : inferWorkspaceReply(message);

  return createAssistantChatMessage(reply.body, reply.sections);
}

export function getChatScopeTitle(scope: ChatScope) {
  if (scope.kind === "node") {
    return `Chat about: ${scope.node.title}`;
  }

  return "Workspace chat";
}

export function getChatScopeMeta(scope: ChatScope) {
  if (scope.kind === "node") {
    return `${scope.node.node_type} • ${scope.node.importance}`;
  }

  return scope.workspaceName;
}

export function getChatComposerPlaceholder(scope: ChatScope) {
  if (scope.kind === "node") {
    return `Ask about ${scope.node.title}...`;
  }

  return "Ask the workspace...";
}

export function getSuggestedPrompts(scope: ChatScope) {
  if (scope.kind === "node") {
    return [
      "Why was this linked?",
      "What supports this node?",
      "What is missing here?",
      "Should this be merged?",
    ];
  }

  return [
    "What matters most right now?",
    "What connects academics to projects?",
    "Which area is underdeveloped?",
    "What should I work on next?",
  ];
}

export function getChatComposerCue(scope: ChatScope) {
  if (scope.kind === "node") {
    return "Use the stage composer below to ask about this node.";
  }

  return "Use the stage composer below to continue.";
}
