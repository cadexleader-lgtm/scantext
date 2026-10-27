import type { OcrLayout, OcrLine, OcrWord } from "../types";

/**
 * Correspondance entre le texte courant d'une page (éventuellement corrigé à
 * la main) et les mots reconnus sur l'image. Sert à placer chaque mot corrigé
 * à sa position exacte (PDF recherchable) et à retrouver dans le texte le mot
 * à relire (mode Relecture).
 */

export interface TextToken {
  text: string;
  /** Position dans le texte (début inclus, fin exclue). */
  start: number;
  end: number;
}

export function tokenize(text: string): TextToken[] {
  const out: TextToken[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

export interface WordRef {
  word: OcrWord;
  /** Ligne d'origine (null pour un mot de tableau). */
  line: OcrLine | null;
}

/** Mots de la page dans l'ordre du texte produit par la reconnaissance. */
export function layoutWords(layout: OcrLayout): WordRef[] {
  const out: WordRef[] = [];
  for (const p of layout.paragraphs) {
    if (p.table) {
      const cells = [...p.table.cells].sort((a, b) => a.r - b.r || a.c - b.c);
      for (const c of cells) for (const w of c.words) out.push({ word: w, line: null });
    } else for (const l of p.lines) for (const w of l.words) out.push({ word: w, line: l });
  }
  return out;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Ressemblance de deux mots (0 à 1, coefficient de Dice sur les paires de lettres). */
export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x[0] === y[0] ? 0.5 : 0;
  const ga = bigrams(x);
  const gb = bigrams(y);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}

/**
 * Alignement (programmation dynamique) des mots du texte sur les mots
 * reconnus : renvoie pour chaque mot du texte l'index du mot reconnu
 * correspondant, ou -1 (mot ajouté à la main).
 */
export function alignTokens(tokens: string[], words: string[]): Int32Array {
  const n = tokens.length;
  const m = words.length;
  const res = new Int32Array(n).fill(-1);
  if (!n || !m) return res;
  // bande autour de la diagonale : les corrections ne déplacent pas le texte très loin
  const band = Math.max(60, Math.abs(n - m) + 60);
  const W = 2 * band + 1;
  const INF = 1e9;
  const cost = new Float64Array((n + 1) * W).fill(INF);
  const dir = new Uint8Array((n + 1) * W); // 1 = diagonale, 2 = mot du texte seul, 3 = mot reconnu seul
  const center = (i: number) => Math.round((i * m) / n);
  const at = (i: number, j: number) => i * W + (j - center(i) + band);
  const inBand = (i: number, j: number) => j >= 0 && j <= m && Math.abs(j - center(i)) <= band;
  const INDEL = 0.9;
  for (let i = 0; i <= n; i++) {
    const c = center(i);
    for (let j = Math.max(0, c - band); j <= Math.min(m, c + band); j++) {
      if (i === 0 && j === 0) {
        cost[at(0, 0)] = 0;
        continue;
      }
      let best = INF;
      let d = 0;
      if (i > 0 && j > 0 && inBand(i - 1, j - 1)) {
        const s = similarity(tokens[i - 1], words[j - 1]);
        const v = cost[at(i - 1, j - 1)] + (s === 1 ? 0 : s >= 0.5 ? 0.5 : 1);
        if (v < best) {
          best = v;
          d = 1;
        }
      }
      if (i > 0 && inBand(i - 1, j)) {
        const v = cost[at(i - 1, j)] + INDEL;
        if (v < best) {
          best = v;
          d = 2;
        }
      }
      if (j > 0 && inBand(i, j - 1)) {
        const v = cost[at(i, j - 1)] + INDEL;
        if (v < best) {
          best = v;
          d = 3;
        }
      }
      cost[at(i, j)] = best;
      dir[at(i, j)] = d;
    }
  }
  let i = n;
  let j = m;
  if (!inBand(n, m)) return res;
  while (i > 0 || j > 0) {
    const d = dir[at(i, j)];
    if (d === 1) {
      res[i - 1] = j - 1;
      i--;
      j--;
    } else if (d === 2) i--;
    else if (d === 3) j--;
    else break;
  }
  return res;
}
