import type { ReactNode } from "react";

type ChatTextBlock =
  | { type: "paragraph"; text: string }
  | { type: "ordered-list"; items: string[] }
  | { type: "unordered-list"; items: string[] }
  | { type: "heading"; level: 1 | 2 | 3; text: string };

function normalizeChatMessageBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/([:!?])\s+(\d+\.\s+)/g, "$1\n$2")
    .replace(/([.])\s+(\d+\.\s+(?:\*\*|[A-Z(]))/g, "$1\n$2")
    .replace(/([:!?])\s+([-*]\s+)/g, "$1\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isOrderedListLine(line: string): boolean {
  return /^\d+\.\s+/.test(line);
}

function isUnorderedListLine(line: string): boolean {
  return /^[-*]\s+/.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^(#{1,3})\s+/.test(line);
}

function parseChatTextBlocks(body: string): ChatTextBlock[] {
  const normalized = normalizeChatMessageBody(body);
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const blocks: ChatTextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: Math.min(3, headingMatch[1].length) as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isOrderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index].trim();
        const listMatch = /^\d+\.\s+(.*)$/.exec(currentLine);
        if (!listMatch) break;

        let itemText = listMatch[1].trim();
        index += 1;

        while (index < lines.length) {
          const continuationLine = lines[index].trim();
          if (
            !continuationLine ||
            isOrderedListLine(continuationLine) ||
            isUnorderedListLine(continuationLine) ||
            isHeadingLine(continuationLine)
          ) {
            break;
          }

          itemText = `${itemText} ${continuationLine}`;
          index += 1;
        }

        items.push(itemText);

        if (index < lines.length && !lines[index].trim()) {
          index += 1;
          break;
        }
      }

      blocks.push({ type: "ordered-list", items });
      continue;
    }

    if (isUnorderedListLine(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index].trim();
        const listMatch = /^[-*]\s+(.*)$/.exec(currentLine);
        if (!listMatch) break;

        let itemText = listMatch[1].trim();
        index += 1;

        while (index < lines.length) {
          const continuationLine = lines[index].trim();
          if (
            !continuationLine ||
            isOrderedListLine(continuationLine) ||
            isUnorderedListLine(continuationLine) ||
            isHeadingLine(continuationLine)
          ) {
            break;
          }

          itemText = `${itemText} ${continuationLine}`;
          index += 1;
        }

        items.push(itemText);

        if (index < lines.length && !lines[index].trim()) {
          index += 1;
          break;
        }
      }

      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const paragraphLines = [line];
    index += 1;

    while (index < lines.length) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        index += 1;
        break;
      }

      if (
        isOrderedListLine(nextLine) ||
        isUnorderedListLine(nextLine) ||
        isHeadingLine(nextLine)
      ) {
        break;
      }

      paragraphLines.push(nextLine);
      index += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderChatInlineText(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const rawMatch = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      parts.push(text.slice(lastIndex, matchIndex));
    }

    if (rawMatch.startsWith("**") && rawMatch.endsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-strong-${matchIndex}`}>
          {rawMatch.slice(2, -2)}
        </strong>,
      );
    } else if (rawMatch.startsWith("`") && rawMatch.endsWith("`")) {
      parts.push(
        <code key={`${keyPrefix}-code-${matchIndex}`}>
          {rawMatch.slice(1, -1)}
        </code>,
      );
    } else if (rawMatch.startsWith("*") && rawMatch.endsWith("*")) {
      parts.push(
        <em key={`${keyPrefix}-em-${matchIndex}`}>
          {rawMatch.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = matchIndex + rawMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

export function ChatRichText({ body }: { body: string }) {
  const blocks = parseChatTextBlocks(body);

  if (blocks.length === 0) {
    return <p>{body}</p>;
  }

  return (
    <div className="chat-rich-text">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const content = renderChatInlineText(block.text, `heading-${index}`);
          if (block.level === 1) return <h1 key={`heading-${index}`}>{content}</h1>;
          if (block.level === 2) return <h2 key={`heading-${index}`}>{content}</h2>;
          return <h3 key={`heading-${index}`}>{content}</h3>;
        }

        if (block.type === "ordered-list") {
          return (
            <ol key={`ol-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`ol-${index}-${itemIndex}`}>
                  {renderChatInlineText(item, `ol-${index}-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === "unordered-list") {
          return (
            <ul key={`ul-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`ul-${index}-${itemIndex}`}>
                  {renderChatInlineText(item, `ul-${index}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={`p-${index}`}>
            {renderChatInlineText(block.text, `p-${index}`)}
          </p>
        );
      })}
    </div>
  );
}
