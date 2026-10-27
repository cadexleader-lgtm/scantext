import { useRef, useState } from "react";
import { ChevronDown, ClipboardCopy, Download } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { downloadBlob } from "../lib/export/download";
import { updateSettings, useSettings } from "../lib/settings";
import { assembleText, countWords, safeFileName } from "../lib/text";
import { hasTable, textToHtml } from "../lib/text-blocks";
import { toast } from "../lib/toast";
import type { PageRecord } from "../lib/types";
import { Button, Dialog, Switch } from "./ui";
import { cn } from "./ui/cn";

function pendingCount(pages: PageRecord[]): number {
  return pages.filter((p) => p.ocrStatus === "pending" || p.ocrStatus === "processing" || p.imageStatus === "pending").length;
}

/**
 * « Copier tout » : réunit le texte réel de toutes les pages, dans l'ordre, et
 * le copie en un clic. En cas de refus du navigateur, une méthode de secours
 * est proposée (sélection manuelle ou téléchargement .txt).
 */
export function CopyAllButton({ pages, docName, className }: { pages: PageRecord[]; docName?: string; className?: string }) {
  const settings = useSettings();
  const [options, setOptions] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  async function copyAll() {
    const text = assembleText(pages, { separators: settings.copySeparators, reflow: settings.copyReflow });
    const waiting = pendingCount(pages);
    if (!text.replace(/[\s—]|Page \d+/g, "")) {
      toast(waiting ? `Aucun texte pour l'instant : ${waiting} page${waiting > 1 ? "s" : ""} en cours de reconnaissance.` : "Aucun texte à copier : les pages sont vides.");
      return;
    }
    try {
      await copyText(text, hasTable(text) ? textToHtml(text) : undefined);
      const words = countWords(text).toLocaleString("fr-FR");
      toast.success(
        `Texte copié : ${pages.length} page${pages.length > 1 ? "s" : ""}, ${words} mots.` +
          (waiting ? ` Attention : ${waiting} page${waiting > 1 ? "s n'ont" : " n'a"} pas encore de texte.` : ""),
      );
    } catch {
      setFallback(text);
    }
  }

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Button
          variant="primary"
          size="lg"
          className="min-w-0 flex-1 gap-2 rounded-r-none px-3"
          icon={<ClipboardCopy className="size-5 shrink-0 max-[400px]:hidden" aria-hidden />}
          onClick={() => void copyAll()}
        >
          <span className="truncate">Copier tout</span>
        </Button>
        <Button
          variant="primary"
          size="lg"
          aria-label="Options de copie"
          title="Options de copie"
          className="rounded-l-none border-l border-white/25 px-2"
          onClick={() => setOptions(true)}
        >
          <ChevronDown className="size-5" />
        </Button>
      </div>

      <Dialog
        open={options}
        onClose={() => setOptions(false)}
        title="Options de copie"
        description="Ces réglages s'appliquent aussi aux exports."
        footer={
          <Button
            variant="primary"
            icon={<ClipboardCopy className="size-5" aria-hidden />}
            onClick={() => {
              setOptions(false);
              void copyAll();
            }}
          >
            Copier tout
          </Button>
        }
      >
        <Switch
          checked={settings.copySeparators}
          onChange={(copySeparators) => updateSettings({ copySeparators })}
          label="Conserver les séparateurs de pages"
          description="Insère « ——— Page 3 ——— » entre les pages."
        />
        <Switch
          checked={settings.copyReflow}
          onChange={(copyReflow) => updateSettings({ copyReflow })}
          label="Recoller les lignes en paragraphes"
          description="Supprime les retours à la ligne de l'impression à l'intérieur d'un paragraphe."
        />
      </Dialog>

      <Dialog
        open={fallback !== null}
        onClose={() => setFallback(null)}
        title="Copie automatique impossible"
        description="Votre navigateur a bloqué l'accès au presse-papiers. Sélectionnez le texte ci-dessous puis copiez-le (appui long → Copier, ou Ctrl+C), ou téléchargez-le."
        wide
        footer={
          <>
            <Button
              icon={<Download className="size-4" aria-hidden />}
              onClick={() => {
                downloadBlob(new Blob(["﻿" + (fallback ?? "")], { type: "text/plain;charset=utf-8" }), `${safeFileName(docName ?? "texte")}.txt`);
              }}
            >
              Télécharger .txt
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const ta = fallbackRef.current;
                if (!ta) return;
                ta.focus();
                ta.select();
                ta.setSelectionRange(0, ta.value.length);
              }}
            >
              Tout sélectionner
            </Button>
          </>
        }
      >
        <textarea
          ref={fallbackRef}
          readOnly
          value={fallback ?? ""}
          className="h-64 w-full rounded-xl border border-line p-3 font-mono text-sm"
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Texte à copier"
        />
      </Dialog>
    </>
  );
}
