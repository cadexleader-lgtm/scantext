import { useMemo } from "react";
import { ClipboardCopy, Table2 } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { setPageText } from "../lib/store";
import { parseBlocks, setTableCell, tableText, textToHtml, type TextBlock } from "../lib/text-blocks";
import { toast } from "../lib/toast";
import type { PageRecord } from "../lib/types";
import { Button } from "./ui";

type TableBlock = Extract<TextBlock, { kind: "table" }>;

/**
 * Tableaux de la page, modifiables case par case. Le texte de la page reste
 * la référence : chaque case modifiée y est réécrite (colonnes séparées par
 * des tabulations), si bien que copie et exports suivent.
 */
export function PageTables({ page }: { page: PageRecord }) {
  const tables = useMemo(() => parseBlocks(page.text).filter((b): b is TableBlock => b.kind === "table"), [page.text]);
  if (!tables.length) return null;
  return (
    <div className="mt-3 min-w-0 space-y-3">
      {tables.map((t, i) => (
        <TableEditor key={i} index={i} count={tables.length} block={t} page={page} />
      ))}
    </div>
  );
}

function TableEditor({ block, page, index, count }: { block: TableBlock; page: PageRecord; index: number; count: number }) {
  // largeur de chaque colonne selon son contenu (le tableau défile horizontalement s'il est large)
  const widths = Array.from({ length: block.cols }, (_, c) => Math.min(32, Math.max(6, ...block.rows.map((r) => (r[c] ?? "").length))) + 2);
  async function copy() {
    const text = tableText(block.rows);
    try {
      await copyText(text, textToHtml(text));
      toast.success("Tableau copié : collez-le dans un tableur ou un traitement de texte.");
    } catch {
      toast.error("La copie n'est pas autorisée par ce navigateur.");
    }
  }
  return (
    <section className="min-w-0 rounded-xl border border-line bg-slate-50/60 p-2" aria-label={`Tableau ${index + 1}`}>
      <div className="mb-2 flex items-center gap-2 px-1 text-sm">
        <Table2 className="size-4 text-brand-700" aria-hidden />
        <span className="font-medium text-ink">{count > 1 ? `Tableau ${index + 1}` : "Tableau"}</span>
        <span className="text-muted">
          {block.rows.length} × {block.cols}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<ClipboardCopy className="size-4" aria-hidden />} onClick={() => void copy()}>
          Copier
        </Button>
      </div>
      <div className="max-w-full overflow-x-auto overscroll-x-contain">
        <table className="w-full border-collapse text-[15px]" style={{ tabSize: 4 }}>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className="border border-slate-300 bg-white p-0 align-top" style={{ minWidth: `${widths[c]}ch` }}>
                    <input
                      value={cell}
                      onChange={(e) => setPageText(page.id, setTableCell(page.text, block, r, c, e.target.value))}
                      aria-label={`Rangée ${r + 1}, colonne ${c + 1}`}
                      className="block w-full min-w-0 bg-transparent px-2 py-1.5 outline-none focus:bg-brand-50"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
