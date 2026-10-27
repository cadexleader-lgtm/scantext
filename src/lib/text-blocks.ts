/**
 * Structure d'un texte de page : paragraphes et tableaux.
 *
 * Le texte reste la seule référence (l'utilisateur peut tout corriger) ; un
 * tableau y est écrit comme dans un tableur collé en texte brut : une rangée
 * par ligne, cases séparées par une tabulation. Toute suite de lignes
 * contenant une tabulation forme un tableau.
 */

export type TextBlock =
  | { kind: "para"; lines: string[]; start: number; end: number }
  | { kind: "table"; rows: string[][]; cols: number; start: number; end: number };

export const isTableLine = (line: string): boolean => line.includes("\t");

/** Découpe un texte en paragraphes et tableaux (positions dans le texte d'origine). */
export function parseBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = text.split("\n");
  let pos = 0;
  let cur: { table: boolean; lines: string[]; start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    if (cur.table) {
      const rows = cur.lines.map((l) => l.replace(/\r$/, "").split("\t"));
      const cols = Math.max(...rows.map((r) => r.length));
      blocks.push({ kind: "table", rows: rows.map((r) => [...r, ...new Array<string>(cols - r.length).fill("")]), cols, start: cur.start, end: cur.end });
    } else blocks.push({ kind: "para", lines: cur.lines, start: cur.start, end: cur.end });
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const start = pos;
    pos += raw.length + 1;
    if (!line.trim()) {
      flush();
      continue;
    }
    const table = isTableLine(line);
    if (cur && cur.table !== table) flush();
    if (!cur) cur = { table, lines: [], start, end: start };
    cur.lines.push(line);
    cur.end = start + raw.length;
  }
  flush();
  return blocks;
}

export const hasTable = (text: string): boolean => /\t/.test(text);

/** Texte d'un tableau (inverse de parseBlocks pour un bloc tableau). */
export const tableText = (rows: string[][]): string => rows.map((r) => r.join("\t")).join("\n");

/** Remplace une case d'un tableau du texte ; renvoie le nouveau texte. */
export function setTableCell(text: string, block: Extract<TextBlock, { kind: "table" }>, r: number, c: number, value: string): string {
  const rows = block.rows.map((row) => [...row]);
  rows[r][c] = value.replace(/[\t\r\n]+/g, " ");
  return text.slice(0, block.start) + tableText(rows) + text.slice(block.end);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Version HTML (presse-papiers) : collée dans Word, Google Docs ou un tableur,
 * un tableau garde ses cases.
 */
export function textToHtml(text: string): string {
  const parts = parseBlocks(text).map((b) => {
    if (b.kind === "para") return `<p>${b.lines.map(escapeHtml).join("<br>")}</p>`;
    const cell = (v: string) => `<td style="border:1px solid #999;padding:4px 8px;vertical-align:top">${escapeHtml(v) || "&nbsp;"}</td>`;
    return `<table style="border-collapse:collapse">${b.rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</table>`;
  });
  return `<meta charset="utf-8">${parts.join("\n")}`;
}
