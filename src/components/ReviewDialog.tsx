import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, SpellCheck2 } from "lucide-react";
import { alignTokens, layoutWords, tokenize } from "../lib/ocr/align";
import { markVerified } from "../lib/ocr/queue";
import { setPageText } from "../lib/store";
import type { PageRecord } from "../lib/types";
import { useBlobUrl } from "./common";
import { Button, Dialog } from "./ui";

/** Sous ce seuil de confiance, un mot est proposé à la relecture. */
export const REVIEW_CONFIDENCE = 80;

export interface ReviewItem {
  /** Index du mot reconnu. */
  word: number;
  box: [number, number, number, number];
  /** Ligne d'origine (zone d'image montrée autour du mot). */
  lineBox: [number, number, number, number] | null;
  confidence: number;
  /** Position du mot correspondant dans le texte courant. */
  start: number;
  end: number;
  current: string;
}

/**
 * Mots peu sûrs de la page, retrouvés dans le texte courant (même corrigé) par
 * alignement sur les mots reconnus.
 */
export function reviewItems(page: Pick<PageRecord, "text" | "layout">): ReviewItem[] {
  if (!page.layout) return [];
  const refs = layoutWords(page.layout);
  const tokens = tokenize(page.text);
  const match = alignTokens(
    tokens.map((t) => t.text),
    refs.map((r) => r.word.t),
  );
  const out: ReviewItem[] = [];
  match.forEach((k, i) => {
    if (k < 0) return;
    const r = refs[k];
    if (r.word.c >= REVIEW_CONFIDENCE) return;
    out.push({
      word: k,
      box: r.word.b,
      lineBox: r.line?.b ?? null,
      confidence: r.word.c,
      start: tokens[i].start,
      end: tokens[i].end,
      current: tokens[i].text,
    });
  });
  return out;
}

/** Extrait de la photo autour du mot, mot encadré. */
function WordSnippet({ url, item, imgW, imgH }: { url: string | null; item: ReviewItem; imgW: number; imgH: number }) {
  const [x0, y0, x1, y1] = item.box;
  const h = y1 - y0;
  const lb = item.lineBox;
  // la ligne entière si elle n'est pas trop longue, sinon une fenêtre autour du mot
  const span = Math.max((x1 - x0) * 5, imgW * 0.45);
  let vx0 = lb ? lb[0] : x0 - span / 2;
  let vx1 = lb ? lb[2] : x1 + span / 2;
  if (vx1 - vx0 > span) {
    const cx = (x0 + x1) / 2;
    vx0 = Math.max(0, cx - span / 2);
    vx1 = Math.min(imgW, vx0 + span);
  }
  const vy0 = Math.max(0, (lb ? lb[1] : y0) - h * 0.8);
  const vy1 = Math.min(imgH, (lb ? lb[3] : y1) + h * 0.8);
  const pad = h * 0.18;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      {url ? (
        <svg viewBox={`${vx0} ${vy0} ${Math.max(1, vx1 - vx0)} ${Math.max(1, vy1 - vy0)}`} className="block h-auto max-h-40 w-full" role="img" aria-label="Extrait de la photo">
          <image href={url} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="none" />
          <rect
            x={x0 - pad}
            y={y0 - pad}
            width={x1 - x0 + 2 * pad}
            height={h + 2 * pad}
            rx={pad}
            fill="rgba(251,191,36,0.18)"
            stroke="#d97706"
            strokeWidth={Math.max(1.5, h * 0.08)}
          />
        </svg>
      ) : (
        <div className="h-24 animate-pulse bg-slate-100" />
      )}
    </div>
  );
}

/**
 * Relecture guidée : chaque mot dont la reconnaissance est peu sûre est montré
 * sur la photo ; on le corrige ou on le confirme, puis on passe au suivant.
 */
export function ReviewDialog({ page, open, onClose }: { page: PageRecord; open: boolean; onClose: () => void }) {
  const url = useBlobUrl(open ? page.id : undefined, "proc", page.imageRev);
  const items = useMemo(() => (open ? reviewItems(page) : []), [open, page]);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0); // index du mot reconnu en cours
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    setDone(new Set());
    setHistory([]);
    setCursor(items[0]?.word ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seulement à l'ouverture
  }, [open]);

  const current = items.find((it) => it.word === cursor && !done.has(it.word)) ?? items.find((it) => it.word >= cursor && !done.has(it.word));
  const remaining = items.filter((it) => !done.has(it.word)).length;

  useEffect(() => {
    if (!current) return;
    setValue(current.current);
    requestAnimationFrame(() => input.current?.select());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nouveau mot affiché
  }, [current?.word]);

  function next(correction: string | null) {
    if (!current) return;
    if (correction !== null && correction.trim() && correction !== current.current) {
      setPageText(page.id, page.text.slice(0, current.start) + correction.trim() + page.text.slice(current.end));
    }
    setDone((d) => new Set(d).add(current.word));
    setHistory((h) => [...h, current.word]);
    const after = items.find((it) => it.word > current.word && !done.has(it.word));
    setCursor(after ? after.word : (items.find((it) => !done.has(it.word) && it.word !== current.word)?.word ?? current.word + 1));
  }

  function back() {
    const prev = history[history.length - 1];
    if (prev === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setDone((d) => {
      const n = new Set(d);
      n.delete(prev);
      return n;
    });
    setCursor(prev);
  }

  const total = items.length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Relecture des mots douteux"
      description={
        total
          ? `${total - remaining} sur ${total} relus. Comparez avec la photo, corrigez si besoin.`
          : "Aucun mot douteux sur cette page."
      }
      footer={
        current ? (
          <>
            <Button variant="ghost" className="mr-auto" icon={<ChevronLeft className="size-4" aria-hidden />} disabled={!history.length} onClick={back}>
              Précédent
            </Button>
            <Button icon={<Check className="size-4" aria-hidden />} onClick={() => next(null)}>
              C'est juste
            </Button>
            <Button variant="primary" onClick={() => next(value)}>
              Corriger
            </Button>
          </>
        ) : (
          <>
            {page.ocrStatus === "review" && (
              <Button
                onClick={() => {
                  void markVerified(page.id);
                  onClose();
                }}
              >
                Marquer la page comme vérifiée
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Terminer
            </Button>
          </>
        )
      }
    >
      {current ? (
        <form
          className="space-y-3 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            next(value);
          }}
        >
          <WordSnippet url={url} item={current} imgW={page.procW} imgH={page.procH} />
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-sm text-muted">
              <span>Mot reconnu (confiance {current.confidence} %)</span>
              <span>{remaining} restant{remaining > 1 ? "s" : ""}</span>
            </span>
            <input
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="block h-12 w-full rounded-xl border border-line bg-white px-3 font-serif text-xl text-ink outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              aria-label="Correction du mot"
            />
          </label>
          <p className="text-xs text-muted">Entrée = Corriger. Un mot coupé ou collé peut être saisi avec ses espaces.</p>
        </form>
      ) : (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <SpellCheck2 className="size-10 text-emerald-600" aria-hidden />
          <p className="font-medium text-ink">{total ? "Relecture terminée." : "Rien à relire."}</p>
          <p className="text-sm text-muted">Vous pouvez relire le reste du texte dans l'éditeur.</p>
        </div>
      )}
    </Dialog>
  );
}
