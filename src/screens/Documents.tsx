import { useMemo, useRef, useState } from "react";
import { FolderOpen, Search, Upload } from "lucide-react";
import { BACKUP_EXTENSION } from "../config";
import { AppShell, PageHeader } from "../components/AppShell";
import { DocCard } from "../components/DocCard";
import { Button, EmptyState } from "../components/ui";
import { navigate, paths } from "../lib/router";
import { useSortedDocs } from "../lib/store";
import { normalizeWithMap } from "../lib/text";
import { errorMessage, toast } from "../lib/toast";

export function DocumentsScreen() {
  const docs = useSortedDocs();
  const [query, setQuery] = useState("");
  const [restoring, setRestoring] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const q = normalizeWithMap(query.trim()).norm;
    return q ? docs.filter((d) => normalizeWithMap(d.name).norm.includes(q)) : docs;
  }, [docs, query]);

  async function restore(file: File) {
    setRestoring(true);
    try {
      const { importProject } = await import("../lib/export/project");
      const doc = await importProject(file);
      toast.success(`Projet restauré : « ${doc.name} »`);
      navigate(paths.doc(doc.id));
    } catch (err) {
      toast.error(errorMessage(err, "Restauration impossible."));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        title="Mes documents"
        subtitle={`${docs.length} document${docs.length > 1 ? "s" : ""} sur cet appareil`}
        actions={
          <Button size="sm" icon={<Upload className="size-4" aria-hidden />} loading={restoring} onClick={() => restoreInput.current?.click()}>
            Restaurer
          </Button>
        }
      />
      <input
        ref={restoreInput}
        type="file"
        accept={`.zip,${BACKUP_EXTENSION},application/zip`}
        className="hidden"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (f) void restore(f);
        }}
      />
      <div className="mx-auto max-w-3xl px-4 py-4 sm:px-6">
        {docs.length > 3 && (
          <label className="relative mb-4 block">
            <span className="sr-only">Rechercher un document</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher par nom"
              className="h-12 w-full rounded-xl border border-line bg-white pl-10 pr-3 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
            />
          </label>
        )}
        {filtered.length ? (
          <ul className="grid gap-2">
            {filtered.map((d) => (
              <li key={d.id}>
                <DocCard doc={d} />
              </li>
            ))}
          </ul>
        ) : docs.length ? (
          <p className="py-10 text-center text-muted">Aucun document ne correspond à « {query} ».</p>
        ) : (
          <EmptyState icon={<FolderOpen className="size-8" />} title="Aucun document">
            <p>Vos documents scannés apparaîtront ici. Vous pouvez aussi restaurer une sauvegarde ({BACKUP_EXTENSION}).</p>
            <Button variant="primary" className="mt-5" onClick={() => navigate(paths.newScan())}>
              Scanner un document
            </Button>
          </EmptyState>
        )}
      </div>
    </AppShell>
  );
}
