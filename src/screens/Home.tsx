import { Camera, ChevronRight, FilePlus2, FileText, Images, ShieldCheck, X } from "lucide-react";
import { APP_NAME } from "../config";
import { AppShell, Logo } from "../components/AppShell";
import { openPicker } from "../components/ImportHost";
import { DocCard } from "../components/DocCard";
import { Button } from "../components/ui";
import { navigate, paths } from "../lib/router";
import { updateSettings, useSettings } from "../lib/settings";
import { createDoc, useSortedDocs } from "../lib/store";
import { errorMessage, toast } from "../lib/toast";

export function HomeScreen() {
  const docs = useSortedDocs();
  const settings = useSettings();
  const recent = docs.slice(0, 5);

  async function newDocument() {
    try {
      const doc = await createDoc();
      navigate(paths.doc(doc.id));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6 lg:pt-10">
        <div className="mb-6 flex items-center justify-between lg:hidden">
          <Logo className="text-xl text-brand-900" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Du papier au texte modifiable</h1>
        <p className="mt-2 text-muted">
          Scannez vos pages ou importez des photos et des PDF : {APP_NAME} reconnaît le texte et le réunit dans un seul document.
        </p>

        <div className="mt-6 grid gap-3">
          <Button variant="primary" size="lg" block icon={<Camera className="size-6" aria-hidden />} onClick={() => navigate(paths.newScan())}>
            Scanner avec la caméra
          </Button>
          <div className="grid grid-cols-2 gap-3">
            <Button size="lg" className="h-auto flex-col py-3 sm:flex-row" icon={<Images className="size-6" aria-hidden />} onClick={() => openPicker("images", { docId: null })}>
              Importer des photos
            </Button>
            <Button size="lg" className="h-auto flex-col py-3 sm:flex-row" icon={<FileText className="size-6" aria-hidden />} onClick={() => openPicker("pdf", { docId: null })}>
              Importer un PDF
            </Button>
          </div>
          <Button variant="subtle" size="lg" block icon={<FilePlus2 className="size-5" aria-hidden />} onClick={() => void newDocument()}>
            Nouveau document
          </Button>
        </div>

        {!settings.storageNoticeDismissed && (
          <div className="mt-6 flex gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-900" role="note">
            <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
            <p className="flex-1">
              <strong>Vos documents ne quittent pas cet appareil.</strong> Ils sont enregistrés dans votre navigateur : ils peuvent être perdus si vous effacez les données du site
              ou changez d'appareil. Exportez ou sauvegardez les documents importants.
            </p>
            <button type="button" aria-label="Masquer ce message" onClick={() => updateSettings({ storageNoticeDismissed: true })} className="-mr-1 -mt-1 self-start p-1">
              <X className="size-5" />
            </button>
          </div>
        )}

        <section className="mt-8" aria-labelledby="recent-title">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="recent-title" className="text-lg font-semibold">
              Documents récents
            </h2>
            {docs.length > 0 && (
              <a
                href="#/documents"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(paths.documents());
                }}
                className="inline-flex items-center gap-0.5 text-sm font-medium text-brand-700"
              >
                Tout voir <ChevronRight className="size-4" aria-hidden />
              </a>
            )}
          </div>
          {recent.length ? (
            <ul className="grid gap-2">
              {recent.map((d) => (
                <li key={d.id}>
                  <DocCard doc={d} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-2xl border border-dashed border-line bg-white p-6 text-center text-sm text-muted">
              Aucun document pour l'instant. Commencez par scanner une page.
            </p>
          )}
        </section>
      </div>
    </AppShell>
  );
}
