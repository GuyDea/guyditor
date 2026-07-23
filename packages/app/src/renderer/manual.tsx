import type { ReactNode } from "react";

export interface ManualSection {
  heading: string | null;
  source: string;
}

export interface ManualDocumentModel {
  sections: ManualSection[];
}

export function parseManual(source: string): ManualDocumentModel {
  const sections: ManualSection[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length === 0) return;
    sections.push({ heading, source: lines.join("\n").trim() });
  };
  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    const sectionHeading = line.match(/^##\s+(.+)$/u);
    if (sectionHeading !== null) {
      flush();
      heading = sectionHeading[1] ?? "";
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  flush();
  return { sections };
}

export function filterManualSections(
  document: ManualDocumentModel,
  query: string,
): ManualDocumentModel {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return document;
  return {
    sections: document.sections.filter(({ heading, source }) =>
      `${heading ?? ""}\n${source}`.toLocaleLowerCase().includes(normalized)),
  };
}

function plainText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_`]/gu, "")
    .trim();
}

export function headingAnchor(value: string): string {
  return plainText(value).toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function repositoryPath(href: string): string {
  if (href.startsWith("../")) return href.replace(/^(?:\.\.\/)+/u, "");
  return `docs/${href.replace(/^\.\//u, "")}`;
}

function InlineMarkdown({
  onRepositoryLink,
  source,
}: {
  onRepositoryLink: (path: string) => void;
  source: string;
}): React.JSX.Element {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    if (index > offset) nodes.push(source.slice(offset, index));
    const token = match[0];
    const key = `${String(index)}-${token}`;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? "";
      if (href.startsWith("#") || /^https?:\/\//u.test(href)) {
        nodes.push(
          <a
            href={href}
            key={key}
            rel={href.startsWith("#") ? undefined : "noreferrer"}
            target={href.startsWith("#") ? undefined : "_blank"}
          >{label}</a>,
        );
      } else {
        nodes.push(
          <a
            href={href}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              onRepositoryLink(repositoryPath(href));
            }}
          >{label}</a>,
        );
      }
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push(source.slice(offset));
  return <>{nodes}</>;
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim());
}

function lineKind(line: string, next: string | undefined): string {
  if (/^#{1,6}\s+/u.test(line)) return "heading";
  if (/^---+$/u.test(line.trim())) return "rule";
  if (/^\s*\d+\.\s+/u.test(line)) return "ordered";
  if (/^\s*-\s+/u.test(line)) return "unordered";
  if (line.trim().startsWith("|") &&
    next !== undefined && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/u.test(next)) return "table";
  return "paragraph";
}

function MarkdownBlocks({
  onRepositoryLink,
  source,
}: {
  onRepositoryLink: (path: string) => void;
  source: string;
}): React.JSX.Element {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const kind = lineKind(line, lines[index + 1]);
    if (kind === "heading") {
      const match = line.match(/^(#{1,6})\s+(.+)$/u);
      const level = match?.[1]?.length ?? 2;
      const text = match?.[2] ?? line;
      const Heading = `h${String(level)}` as keyof React.JSX.IntrinsicElements;
      blocks.push(
        <Heading id={headingAnchor(text)} key={`heading-${String(index)}`}>
          <a href={`#${headingAnchor(text)}`}>
            <InlineMarkdown source={text} onRepositoryLink={onRepositoryLink} />
          </a>
        </Heading>,
      );
      index += 1;
      continue;
    }
    if (kind === "rule") {
      blocks.push(<hr key={`rule-${String(index)}`} />);
      index += 1;
      continue;
    }
    if (kind === "table") {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className="manual-table-scroll" key={`table-${String(index)}`}>
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => (
              <th key={`${String(cellIndex)}-${cell}`}>
                <InlineMarkdown source={cell} onRepositoryLink={onRepositoryLink} />
              </th>
            ))}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => (
              <tr key={row.join("|")}>
                {row.map((cell, cellIndex) => (
                  <td key={`${String(rowIndex)}-${String(cellIndex)}`}>
                    <InlineMarkdown source={cell} onRepositoryLink={onRepositoryLink} />
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (kind === "ordered" || kind === "unordered") {
      const items: string[] = [];
      const pattern = kind === "ordered" ? /^\s*\d+\.\s+(.+)$/u : /^\s*-\s+(.+)$/u;
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(pattern);
        if (item === null) break;
        items.push(item[1] ?? "");
        index += 1;
      }
      const List = kind === "ordered" ? "ol" : "ul";
      blocks.push(
        <List key={`${kind}-${String(index)}`}>
          {items.map((item, itemIndex) => (
            <li key={`${String(itemIndex)}-${item}`}>
              <InlineMarkdown source={item} onRepositoryLink={onRepositoryLink} />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim().length > 0 &&
      lineKind(lines[index] ?? "", lines[index + 1]) === "paragraph") {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    const text = paragraph.join(" ");
    blocks.push(
      <p key={`paragraph-${String(index)}`}>
        <InlineMarkdown source={text} onRepositoryLink={onRepositoryLink} />
      </p>,
    );
  }
  return <>{blocks}</>;
}

export function MarkdownDocument(props: {
  document: ManualDocumentModel;
  onRepositoryLink: (path: string) => void;
}): React.JSX.Element {
  return (
    <article className="manual-document" data-testid="manual-document">
      {props.document.sections.map((section, index) => (
        <section
          className="manual-section"
          data-manual-section={section.heading ?? "introduction"}
          key={section.heading ?? "introduction"}
        >
          <MarkdownBlocks
            source={section.source}
            onRepositoryLink={props.onRepositoryLink}
          />
          {index === props.document.sections.length - 1 ? null : null}
        </section>
      ))}
    </article>
  );
}
