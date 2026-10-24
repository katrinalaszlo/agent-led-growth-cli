// The quote shown under a step that says the product needs something. Kat reads every one, so a quote is one or two
// whole sentences from one element of the page (a paragraph, a list item, a table cell), never text run together from
// separate elements. Resend's pricing page flattened to "scale as you grow. Are you an AI agent? See pricing Add-ons if
// you send from a": a subtitle, a link and a heading read as one sentence. When the words sit in an element with no
// sentence (a heading, a table cell, a button, a line of code), the quote is that element's text with a label saying
// what it is: Heading: "Domains - $20 / mo".

// Elements that start a new block. Inline elements (a, span, strong, code) stay inside the sentence they are part of.
const BLOCK_TAG = /^<\/?\s*(address|article|aside|blockquote|br|button|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|img|input|label|legend|li|main|menu|nav|ol|option|p|pre|section|select|summary|svg|table|tbody|td|template|textarea|tfoot|th|thead|title|tr|ul)\b/i;
const KIND_OF_TAG = { td: "cell", th: "cell", li: "item", dt: "item", dd: "item", button: "button", option: "button", summary: "button", pre: "code", title: "heading" };
export const LABEL = { cell: "Table cell", heading: "Heading", item: "List item", button: "Button", code: "Code", line: "Line", paragraph: "Text", phrase: "Phrase" };
// An element's text with no sentence in it is quoted whole only up to this length; longer is a run of inline elements
// (a navigation bar, a footer), which is not a quote.
const PHRASE_MAX = 160;
// A sentence longer than this is a run of data (a JSON blob in a page, a minified list), not a sentence to quote.
const SENTENCE_MAX = 320;

function decode(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Blocks of an HTML page, with offsets into htmlToText(html): the same steps in the same order, split where a block
// element starts or ends, so the blocks joined with one space are exactly htmlToText's output.
export function htmlBlocks(html) {
  const src = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const segments = [];
  let kind = "phrase";
  let last = 0;
  for (const m of src.matchAll(/<[^>]+>/g)) {
    const tag = BLOCK_TAG.exec(m[0]);
    if (!tag) continue;
    segments.push({ kind, raw: src.slice(last, m.index) });
    const name = tag[1].toLowerCase();
    const closing = /^<\s*\//.test(m[0]);
    kind = closing ? "phrase" : /^h[1-6]$/.test(name) ? "heading" : KIND_OF_TAG[name] || "phrase";
    last = m.index + m[0].length;
  }
  segments.push({ kind, raw: src.slice(last) });
  const blocks = [];
  let offset = 0;
  for (const seg of segments) {
    const text = decode(seg.raw).replace(/\s+/g, " ").trim();
    if (!text) continue;
    blocks.push({ start: offset, end: offset + text.length, kind: seg.kind, raw: seg.raw });
    offset += text.length + 1;
  }
  return blocks;
}

const FENCE = /^\s*(?:```|~~~)/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_LINE = /^\s*\|/;
// A line that is only an HTML or MDX tag (`<Card title="Verify" href="...">`, `</Card>`) ends a block, like a blank line.
const TAG_LINE = /^\s*<\/?[A-Za-z][^>]*>\s*$/;
const INLINE_BLOCK_TAG = /<\/?\s*(?:td|th|tr|table|thead|tbody|p|li|ul|ol|div|h[1-6])\b[^>]*>/i;
const INLINE_BLOCK_TAG_NAME = /^<(\/)?\s*(td|th|tr|table|thead|tbody|p|li|ul|ol|div|h[1-6])\b/i;
const TAG_KIND = { td: "cell", th: "cell", li: "item", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading" };
function pushPiece(blocks, line, start, a, b, kind) {
  while (a < b && /\s/.test(line[a])) a += 1;
  while (b > a && /\s/.test(line[b - 1])) b -= 1;
  if (b > a) blocks.push({ start: start + a, end: start + b, kind });
}
// A shell-comment block in a text file (AgentMail's llms.txt): "#" alone is a blank line and "#" followed by two or
// more spaces is text, not a heading.
const COMMENT_BLANK = /^\s*#\s*$/;
const COMMENT_TEXT = /^\s*#\s{2,}\S/;

// Blocks of a Markdown or plain-text page, with offsets into the text: a paragraph (lines joined until a blank line),
// a heading, a list item with its wrapped lines, a table cell, a line of a code block. lineMode makes every line its
// own block, for YAML and other line-oriented files.
export function textBlocks(text, { lineMode = false } = {}) {
  const blocks = [];
  let open = null;
  const close = () => {
    if (open) blocks.push(open);
    open = null;
  };
  let inFence = false;
  let at = 0;
  for (const line of text.split("\n")) {
    const start = at;
    const end = at + line.length;
    at = end + 1;
    const blank = !line.trim() || (!inFence && (COMMENT_BLANK.test(line) || TAG_LINE.test(line)));
    if (FENCE.test(line)) {
      close();
      inFence = !inFence;
      continue;
    }
    if (blank) {
      close();
      continue;
    }
    if (inFence || lineMode) {
      close();
      blocks.push({ start, end, kind: inFence ? "code" : "line" });
      continue;
    }
    // HTML or MDX written inline in a text file (AgentID's llms-full.txt has a table as `<td className="...">Can the
    // agent sign up ...</td> <td ...>`): each piece of text between block tags is its own block, as in an HTML page.
    if (INLINE_BLOCK_TAG.test(line)) {
      close();
      let kind = "paragraph";
      let from = 0;
      for (const m of line.matchAll(/<[^>]+>/g)) {
        pushPiece(blocks, line, start, from, m.index, kind);
        const tag = INLINE_BLOCK_TAG_NAME.exec(m[0]);
        if (tag) kind = tag[1] ? "paragraph" : TAG_KIND[tag[2].toLowerCase()] || "paragraph";
        from = m.index + m[0].length;
      }
      pushPiece(blocks, line, start, from, line.length, kind);
      continue;
    }
    if (HEADING_LINE.test(line) && !COMMENT_TEXT.test(line)) {
      close();
      blocks.push({ start, end, kind: "heading" });
      continue;
    }
    if (TABLE_LINE.test(line)) {
      close();
      for (const cell of line.matchAll(/[^|]+/g)) if (cell[0].trim() && !/^[\s:-]+$/.test(cell[0])) blocks.push({ start: start + cell.index, end: start + cell.index + cell[0].length, kind: "cell" });
      continue;
    }
    if (ITEM_LINE.test(line)) {
      close();
      open = { start, end, kind: "item" };
      continue;
    }
    if (open) open.end = end;
    else open = { start, end, kind: "paragraph" };
  }
  close();
  return blocks;
}

const blockCache = new WeakMap();
// The page's blocks over the text the rules read (htmlToText for HTML, the body itself otherwise).
export function blocksOf(body, role) {
  if (blockCache.has(body)) return blockCache.get(body);
  const blocks = body.html ? htmlBlocks(body.text) : isJson(body.text) ? null : textBlocks(body.text, { lineMode: role === "openapi" || role === "sitemap" || role === "robots" });
  blockCache.set(body, blocks);
  return blocks;
}

const isJson = (text) => /^\s*[[{]/.test(text);

// Where one sentence ends inside a block: terminal punctuation, any closing quote, bracket or Markdown mark, then
// space and a character that can start a sentence. Not after an abbreviation ("e.g.", "vs.") or an initial.
const BOUNDARY = /[.!?]["'”’)\]*_`]*(?=\s+[^\sa-z])/g;
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|Inc|Ltd|Co|Mr|Mrs|Ms|Dr|St|No|U\.S)$/;
const TERMINAL = /[.!?]["'”’)\]*_`]*$/;

function sentencesIn(s) {
  const out = [];
  let from = 0;
  for (const m of s.matchAll(BOUNDARY)) {
    if (m[0][0] === "." && ABBREVIATION.test(s.slice(0, m.index))) continue;
    const end = m.index + m[0].length;
    out.push([from, end]);
    from = end;
  }
  out.push([from, s.length]);
  return out.map(([a, b]) => {
    while (a < b && /\s/.test(s[a])) a += 1;
    while (b > a && /\s/.test(s[b - 1])) b -= 1;
    return [a, b];
  }).filter(([a, b]) => b > a);
}

// Markdown marks at the start of a block are layout, not words: "- ", "## ", "> ", "1. ".
// A "#" that opens each line of a comment block is layout too.
const tidy = (s) => s.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\n[ \t]*#(?=\s)/g, "\n").replace(/\s+/g, " ").trim();

// A div's text with no sentence in it is often several links or buttons side by side ("Start Sending Free View B2B
// Plans ($14/mo) Read the Docs"). Its phrase is then only the inline elements the words are in: split at every tag
// but comments, the same way htmlBlocks splits a page, so the pieces line up with the block's text.
function inlinePiece(raw, start, end) {
  const pieces = [];
  let offset = 0;
  for (const part of raw.split(/<(?!!--)[^>]+>/)) {
    const text = decode(part).replace(/\s+/g, " ").trim();
    if (!text) continue;
    pieces.push({ start: offset, end: offset + text.length, text });
    offset += text.length + 1;
  }
  const hit = pieces.filter((p) => p.end > start && p.start < end);
  return hit.length ? hit.map((p) => p.text).join(" ") : null;
}

// { quote, label? } for the words at [start, end) of a block's text, or null when they cross a sentence pair or the
// block is a long run with no sentence in it.
// Sentences are looked for only within WINDOW characters of the match: a 2 MB page on one line would otherwise be split
// end to end for every match. A sentence that reaches the window's edge is longer than any quote, so it is none.
const WINDOW = 1000;
function fromBlock(s, kind, start, end, raw = null) {
  const lo = Math.max(0, start - WINDOW);
  const hi = Math.min(s.length, end + WINDOW);
  const near = s.slice(lo, hi);
  const hit = sentencesIn(near).filter(([a, b]) => b > start - lo && a < end - lo);
  if (!hit.length || hit.length > 2) return null;
  const a = hit[0][0];
  const b = hit.at(-1)[1];
  if ((a === 0 && lo > 0) || (b === near.length && hi < s.length)) return null;
  const piece = tidy(near.slice(a, b));
  if (!piece) return null;
  if (TERMINAL.test(piece) && kind !== "code" && kind !== "cell" && kind !== "heading") return piece.length <= SENTENCE_MAX ? { quote: piece } : null;
  // A Markdown paragraph or list item is one element as its author wrote it, so it is quoted whole even without a full
  // stop (llms.txt lines often have none). A div's text is cut to the inline elements the words are in.
  const phrase = raw !== null && kind === "phrase" ? tidy(inlinePiece(raw, start, end) || "") : piece;
  const max = kind === "paragraph" || kind === "item" ? SENTENCE_MAX : PHRASE_MAX;
  if (!phrase || phrase.length > max) return null;
  return { quote: phrase, label: LABEL[kind] || LABEL.phrase };
}

// A JSON string at [start, end): its text, labelled with its key (description, summary), or for a key itself, "Key"
// ("OpenAPI path" for an OpenAPI path).
function fromJson(text, start, end, role) {
  let qs = start;
  while (qs >= 0 && !(text[qs] === '"' && text[qs - 1] !== "\\")) qs -= 1;
  let qe = end;
  while (qe < text.length && !(text[qe] === '"' && text[qe - 1] !== "\\")) qe += 1;
  if (qs < 0 || qe >= text.length || qe - qs > 2000) return null;
  // Inside a string only when an odd number of unescaped quotes come before the opening one plus it.
  const before = text.slice(0, qs + 1).match(/(?<!\\)"/g)?.length || 0;
  if (before % 2 === 0) return null;
  const raw = text.slice(qs + 1, qe).replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\");
  const isKey = /^\s*:/.test(text.slice(qe + 1, qe + 20));
  if (isKey) return raw.length <= PHRASE_MAX ? { quote: raw, label: role === "openapi" && raw.startsWith("/") ? "OpenAPI path" : "Key" } : null;
  const key = /"([^"\\]{1,40})"\s*:\s*$/.exec(text.slice(Math.max(0, qs - 60), qs))?.[1] || "Value";
  const inner = fromBlock(raw, "phrase", start - qs - 1, end - qs - 1);
  return inner ? { quote: inner.quote, label: key } : null;
}

// The quote for a match at [start, end) of a page's text, or null when no clean quote holds it: the match runs across
// two elements of the page, or its element is a long run with no sentence. A caller with a null tries its next match.
export function quoteAt(body, text, start, end, role) {
  if (!body.html && isJson(body.text)) return fromJson(text, start, end, role);
  const blocks = blocksOf(body, role);
  const block = blocks.find((b) => b.start <= start && end <= b.end);
  if (!block) return null;
  return fromBlock(text.slice(block.start, block.end), block.kind, start - block.start, end - block.start, block.raw ?? null);
}

// The block holding [start, end), and the heading above it on the page, for rules that read what a sentence is about.
export function blockContext(body, text, start, end, role) {
  if (!body.html && isJson(body.text)) return null;
  const blocks = blocksOf(body, role);
  const i = blocks.findIndex((b) => b.start <= start && end <= b.end);
  if (i < 0) return null;
  let h = i - 1;
  while (h >= 0 && blocks[h].kind !== "heading") h -= 1;
  const slice = (b) => (b ? text.slice(b.start, b.end) : "");
  return { block: slice(blocks[i]), heading: h >= 0 ? slice(blocks[h]) : "", previous: slice(blocks[i - 1]) };
}
