import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

function sourceRangeProperties(position) {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return null;
  }
  return {
    "data-source-start": String(start),
    "data-source-end": String(end),
  };
}

function rehypeSourceRanges() {
  return (tree) => {
    function visit(node, parent, index) {
      if (!node || typeof node !== "object") return;
      const properties = sourceRangeProperties(node.position);
      if (node.type === "text" && properties && parent && Number.isSafeInteger(index)) {
        parent.children[index] = {
          type: "element",
          tagName: "span",
          properties,
          children: [{ ...node, position: undefined }],
          position: node.position,
        };
        return;
      }
      if (node.type === "element" && properties) {
        node.properties = { ...(node.properties ?? {}), ...properties };
      }
      if (!Array.isArray(node.children)) return;
      node.children.forEach((child, childIndex) => visit(child, node, childIndex));
    }
    visit(tree, null, null);
  };
}

function rehypeMathSourceRanges() {
  return (tree) => {
    function visit(node) {
      if (!Array.isArray(node?.children)) return;
      node.children.forEach((child, index) => {
        const classes = Array.isArray(child?.properties?.className)
          ? child.properties.className
          : [];
        const fencedMath = child?.tagName === "pre"
          && child.children?.some((item) => (
            Array.isArray(item?.properties?.className)
            && item.properties.className.includes("language-math")
          ));
        const isMath = fencedMath
          || classes.includes("language-math")
          || classes.includes("math-inline")
          || classes.includes("math-display");
        const properties = isMath ? sourceRangeProperties(child.position) : null;
        if (properties) {
          node.children[index] = {
            type: "element",
            tagName: fencedMath || classes.includes("math-display") ? "div" : "span",
            properties: {
              className: ["paper-math-source"],
              ...properties,
            },
            children: [child],
            position: child.position,
          };
          return;
        }
        visit(child);
      });
    }
    visit(tree);
  };
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [
  rehypeRaw,
  rehypeSanitize,
  rehypeMathSourceRanges,
  [rehypeKatex, { strict: "ignore", throwOnError: false }],
  rehypeSourceRanges,
];

const INLINE_COMPONENTS = {
  p: ({ children }) => <span>{children}</span>,
  a: ({ children }) => <span>{children}</span>,
  h1: ({ children }) => <span>{children}</span>,
  h2: ({ children }) => <span>{children}</span>,
  h3: ({ children }) => <span>{children}</span>,
  h4: ({ children }) => <span>{children}</span>,
  h5: ({ children }) => <span>{children}</span>,
  h6: ({ children }) => <span>{children}</span>,
};

export function PaperRichText({
  content,
  inline = false,
  className = "",
}) {
  const source = typeof content === "string" ? content.trim() : "";
  if (!source) return null;
  const Wrapper = inline ? "span" : "div";
  const classes = [
    "paper-rich-text",
    inline ? "is-inline" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <Wrapper className={classes}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={inline ? INLINE_COMPONENTS : undefined}
      >
        {source}
      </ReactMarkdown>
    </Wrapper>
  );
}
