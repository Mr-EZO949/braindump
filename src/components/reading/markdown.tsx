import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

// Sanitized markdown renderer for node bodies.
//
// Security posture: react-markdown does NOT pass through raw HTML unless
// rehype-raw is added — we deliberately don't add it, so any literal HTML in a
// body renders as text. rehype-sanitize is layered on as defense-in-depth (it
// also strips javascript: URLs). The result: bodies are markdown-only, never an
// injection surface. Output is semantic HTML; all typography is styled by the
// scoped `.article` rules in reading-view.module.css.

function isImageOnlyParagraph(node: unknown): boolean {
  const children = (node as { children?: Array<{ type?: string; tagName?: string }> })?.children;
  return (
    Array.isArray(children) &&
    children.length === 1 &&
    children[0]?.type === "element" &&
    children[0]?.tagName === "img"
  );
}

export function Markdown({ body }: { body: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        // Images sit as block figures at column width, captioned from alt text.
        // Markdown wraps a lone image in a <p>; unwrap it so <figure> isn't
        // nested inside a <p> (invalid HTML).
        p: ({ node, children }) =>
          isImageOnlyParagraph(node) ? <>{children}</> : <p>{children}</p>,
        img: ({ src, alt }) =>
          typeof src === "string" ? (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={alt ?? ""} loading="lazy" />
              {alt ? <figcaption>{alt}</figcaption> : null}
            </figure>
          ) : null,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
          </a>
        ),
      }}
    >
      {body}
    </ReactMarkdown>
  );
}
