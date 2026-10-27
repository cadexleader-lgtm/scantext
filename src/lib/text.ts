import { isTableLine } from "./text-blocks";
import type { PageRecord } from "./types";

export interface AssembleOptions {
  /** Insérer « — Page N — » entre les pages. */
  separators: boolean;
  /** Recoller les lignes d'un même paragraphe (retours à la ligne de l'impression). */
  reflow: boolean;
}

export const pageSeparator = (n: number): string => `——— Page ${n} ———`;

const LIST_ITEM = /^\s*([-–—•*·●▪◦]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/;

/**
 * Recolle les lignes d'un paragraphe en une seule ligne. Les lignes vides
 * (séparation de paragraphes) et les éléments de liste sont conservés ; un mot
 * coupé en fin de ligne (« exem- / ple ») est recollé seulement si la ligne
 * suivante commence par une minuscule.
 */
export function reflowText(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  return paragraphs
    .map((para) => {
      // les tabulations délimitent les cases d'un tableau : on ne retire que les espaces
      const lines = para
        .split("\n")
        .map((l) => l.replace(/^ +| +$/g, ""))
        .filter((l) => l.trim());
      let out = "";
      for (const line of lines) {
        if (!out) {
          out = line;
          continue;
        }
        // les rangées d'un tableau restent sur leur ligne
        if (isTableLine(line) || isTableLine(out.slice(out.lastIndexOf("\n") + 1))) {
          out += "\n" + line;
        } else if (LIST_ITEM.test(line)) {
          out += "\n" + line;
        } else if (/[A-Za-zÀ-ÿ]-$/.test(out) && /^\p{Ll}/u.test(line)) {
          out = out.slice(0, -1) + line;
        } else {
          out += " " + line;
        }
      }
      return out;
    })
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/** Texte d'une page tel qu'il sera copié / exporté. */
export function pageOutputText(page: Pick<PageRecord, "text">, reflow: boolean): string {
  const t = page.text.replace(/\r\n?/g, "\n").replace(/[ \n]+$/, "");
  return reflow ? reflowText(t) : t;
}

/** Réunit le texte de toutes les pages, dans l'ordre. */
export function assembleText(pages: Pick<PageRecord, "text">[], opts: AssembleOptions): string {
  const parts: string[] = [];
  pages.forEach((p, i) => {
    const t = pageOutputText(p, opts.reflow);
    if (opts.separators) parts.push(t ? `${pageSeparator(i + 1)}\n\n${t}` : pageSeparator(i + 1));
    else if (t.trim()) parts.push(t);
  });
  return parts.join("\n\n").trim() + (parts.length ? "\n" : "");
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

// ------------------------------------------------------------------ recherche

/** Texte normalisé (sans accents, minuscules) + correspondance des positions vers l'original. */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const base = text[i].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < base.length; k++) {
      norm += base[k];
      map.push(i);
    }
  }
  map.push(text.length);
  return { norm, map };
}

export interface Match {
  pageId: string;
  pageIndex: number;
  start: number;
  end: number;
}

/** Recherche insensible à la casse et aux accents (« eleve » trouve « élève »). */
export function findMatches(pages: Pick<PageRecord, "id" | "text">[], query: string): Match[] {
  const q = normalizeWithMap(query.trim()).norm;
  if (!q) return [];
  const out: Match[] = [];
  pages.forEach((p, pageIndex) => {
    const { norm, map } = normalizeWithMap(p.text);
    let from = 0;
    for (;;) {
      const i = norm.indexOf(q, from);
      if (i < 0) break;
      out.push({ pageId: p.id, pageIndex, start: map[i], end: map[i + q.length - 1] + 1 });
      from = i + Math.max(1, q.length);
    }
  });
  return out;
}

/** Remplace toutes les occurrences (même règle d'insensibilité que la recherche). */
export function replaceAll(text: string, query: string, replacement: string): { text: string; count: number } {
  const matches = findMatches([{ id: "", text }], query);
  if (!matches.length) return { text, count: 0 };
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacement;
    last = m.end;
  }
  return { text: out + text.slice(last), count: matches.length };
}

// ------------------------------------------------------------------ fichiers

/** Nom de fichier sûr sur tous les systèmes (sans extension). */
export function safeFileName(name: string, fallback = "document"): string {
  const cleaned = name
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- caractères de contrôle interdits dans les noms de fichiers
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

export function stripExtension(name: string): string {
  return name.replace(/\.(txt|docx|pdf|zip|scantext\.zip)$/i, "");
}
