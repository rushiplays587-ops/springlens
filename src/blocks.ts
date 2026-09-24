/**
 * A tiny document model shared by the Markdown and HTML renderers, so both
 * outputs say the same thing and both escape untrusted text (class names, file
 * paths, config values, AI narrative) in one place each.
 *
 * Rule for authors of blocks: a plain string is our own literal wording; anything
 * that came from the scanned repo goes into a {code}, {i} or {b} span. Both
 * renderers still escape every string, so a mistake here cannot inject markup.
 */

export type Span = string | { code: string } | { i: string } | { b: string };

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4; text: Span[] }
  | { t: "p"; text: Span[] }
  | { t: "note"; text: Span[] }
  | { t: "ul"; items: Span[][] }
  | { t: "table"; head: string[]; rows: Span[][][] };

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

// ---------- Markdown ----------

function mdEscapeText(s: string): string {
  return oneLine(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdCode(s: string): string {
  const text = oneLine(s);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function mdSpans(spans: Span[]): string {
  return spans
    .map((s) => {
      if (typeof s === "string") return mdEscapeText(s);
      if ("code" in s) return mdCode(s.code);
      if ("i" in s) return `*${mdEscapeText(s.i).replace(/[*\\]/g, "\\$&")}*`;
      return `**${mdEscapeText(s.b).replace(/[*\\]/g, "\\$&")}**`;
    })
    .join("");
}

export function renderMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "h":
        out.push(`${"#".repeat(b.level)} ${mdSpans(b.text)}`);
        break;
      case "p":
        out.push(mdSpans(b.text));
        break;
      case "note":
        out.push(`_${mdSpans(b.text).replace(/_/g, "\\_")}_`);
        break;
      case "ul":
        out.push(b.items.map((item) => `- ${mdSpans(item)}`).join("\n"));
        break;
      case "table": {
        const cell = (s: string) => s.replace(/\|/g, "\\|");
        out.push(
          [
            `| ${b.head.map((h) => cell(mdEscapeText(h))).join(" | ")} |`,
            `| ${b.head.map(() => "---").join(" | ")} |`,
            ...b.rows.map((row) => `| ${row.map((c) => cell(mdSpans(c)) || " ").join(" | ")} |`),
          ].join("\n")
        );
        break;
      }
    }
  }
  return out.join("\n\n") + "\n";
}

// ---------- HTML ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlSpans(spans: Span[]): string {
  return spans
    .map((s) => {
      if (typeof s === "string") return escapeHtml(s);
      if ("code" in s) return `<code>${escapeHtml(s.code)}</code>`;
      if ("i" in s) return `<em>${escapeHtml(s.i)}</em>`;
      return `<strong>${escapeHtml(s.b)}</strong>`;
    })
    .join("");
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--code:#f3f4f6;--accent:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--fg:#e6e8eb;--muted:#9aa4af;--line:#2f3741;--code:#1a2028;--accent:#6cb2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:60rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .5em}
h1{font-size:1.8rem;margin-top:0}
h2{font-size:1.4rem;border-bottom:1px solid var(--line);padding-bottom:.25em}
h3{font-size:1.15rem}
h4{font-size:1rem;color:var(--muted)}
p,ul{margin:.6em 0}
ul{padding-left:1.3rem}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:.1em .35em;border-radius:4px;overflow-wrap:anywhere}
.note{color:var(--muted);font-style:italic}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{border:1px solid var(--line);padding:.35rem .6rem;text-align:left;vertical-align:top}
th{background:var(--code)}
@media print{body{background:#fff;color:#000;font-size:11pt}main{max-width:none;padding:0}h2,h3,h4{break-after:avoid}table,ul{break-inside:avoid}code{background:none;border:1px solid #ccc}}
`;

/**
 * A single self-contained HTML page: inline CSS, no scripts, no external requests.
 * The Content-Security-Policy meta tag forbids scripts and any network fetch, so even
 * a hypothetical escaping mistake could not run code or leak data from the page.
 */
export function renderHtml(title: string, blocks: Block[]): string {
  const body = blocks
    .map((b) => {
      switch (b.t) {
        case "h":
          return `<h${b.level}>${htmlSpans(b.text)}</h${b.level}>`;
        case "p":
          return `<p>${htmlSpans(b.text)}</p>`;
        case "note":
          return `<p class="note">${htmlSpans(b.text)}</p>`;
        case "ul":
          return `<ul>${b.items.map((item) => `<li>${htmlSpans(item)}</li>`).join("")}</ul>`;
        case "table":
          return (
            `<div class="table-wrap"><table><thead><tr>${b.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
            `<tbody>${b.rows.map((row) => `<tr>${row.map((c) => `<td>${htmlSpans(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
          );
      }
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
