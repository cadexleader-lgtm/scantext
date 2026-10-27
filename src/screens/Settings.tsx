import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CloudDownload, HardDrive, Smartphone, Trash2, WifiOff } from "lucide-react";
import { APP_NAME } from "../config";
import { AppShell, PageHeader } from "../components/AppShell";
import { Button, Segmented, Switch } from "../components/ui";
import { confirmAction } from "../components/ui/dialogs";
import { getOfflineStatus, langsOf, prepareOffline, type OfflineStatus } from "../lib/offline";
import { isIos, promptInstall, useInstallState } from "../lib/pwa";
import { updateSettings, useSettings, type ImageQuality } from "../lib/settings";
import { formatBytes, getStorageInfo, requestPersistence, type StorageInfo } from "../lib/storage";
import { clearAllData } from "../lib/store";
import { errorMessage, toast } from "../lib/toast";
import type { FilterId, OcrLang } from "../lib/types";

export const LANG_OPTIONS: { value: OcrLang; label: string }[] = [
  { value: "fra", label: "Français" },
  { value: "eng", label: "Anglais" },
  { value: "fra+eng", label: "Les deux" },
];
export const FILTER_OPTIONS: { value: FilterId; label: string }[] = [
  { value: "enhanced", label: "Document" },
  { value: "gray", label: "Gris" },
  { value: "bw", label: "N&B" },
  { value: "color", label: "Couleur" },
];

function Section({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-5">
      <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="py-2">
      <p className="mb-2 font-medium">{label}</p>
      {children}
      {hint && <p className="mt-1.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function SettingsScreen() {
  const s = useSettings();
  const install = useInstallState();
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [offline, setOffline] = useState<OfflineStatus | null>(null);
  const [preparing, setPreparing] = useState(false);

  const refresh = useCallback(async () => {
    setStorage(await getStorageInfo());
    setOffline(await getOfflineStatus(langsOf(s.lang)));
  }, [s.lang]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function protect() {
    const ok = await requestPersistence();
    if (ok) toast.success("Le navigateur conservera vos documents (pas d'effacement automatique).");
    else toast.error("Le navigateur a refusé. Installer l'application sur l'écran d'accueil augmente souvent la protection.");
    void refresh();
  }

  async function prepare() {
    setPreparing(true);
    try {
      await prepareOffline(langsOf(s.lang));
      toast.success("La reconnaissance de texte est disponible hors ligne.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPreparing(false);
      void refresh();
    }
  }

  async function wipe() {
    const ok = await confirmAction({
      title: "Supprimer toutes les données ?",
      message: "Tous les documents, images et textes enregistrés sur cet appareil seront définitivement supprimés.",
      confirmLabel: "Tout supprimer",
      danger: true,
    });
    if (!ok) return;
    try {
      await clearAllData();
      toast.success("Toutes les données ont été supprimées.");
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <AppShell>
      <PageHeader title="Paramètres" />
      <div className="mx-auto grid max-w-3xl gap-4 px-4 py-4 sm:px-6">
        <Section title="Reconnaissance du texte">
          <Field label="Langue des nouveaux documents" hint="Modifiable pour chaque document. « Les deux » est plus lent : à réserver aux documents bilingues.">
            <Segmented label="Langue" value={s.lang} onChange={(lang) => updateSettings({ lang })} options={LANG_OPTIONS} className="w-full" />
          </Field>
        </Section>

        <Section title="Scan">
          <Switch
            checked={s.quickCapture}
            onChange={(quickCapture) => updateSettings({ quickCapture })}
            label="Scan rapide"
            description="Chaque photo est ajoutée directement (recadrage automatique), sans écran de vérification. Vous pourrez recadrer ensuite."
          />
          <Field label="Filtre par défaut" hint="« Document » supprime les ombres et renforce le contraste : idéal pour la reconnaissance.">
            <Segmented label="Filtre par défaut" value={s.defaultFilter} onChange={(defaultFilter) => updateSettings({ defaultFilter })} options={FILTER_OPTIONS} className="w-full" />
          </Field>
          <Field label="Qualité des images" hint="Une qualité élevée améliore la reconnaissance des petits caractères mais occupe plus d'espace (≈ 0,5 à 1,5 Mo par page).">
            <Segmented<ImageQuality>
              label="Qualité des images"
              value={s.imageQuality}
              onChange={(imageQuality) => updateSettings({ imageQuality })}
              options={[
                { value: "eco", label: "Économie" },
                { value: "standard", label: "Standard" },
                { value: "high", label: "Haute" },
              ]}
              className="w-full"
            />
          </Field>
        </Section>

        <Section title="Copie et export">
          <Switch
            checked={s.copySeparators}
            onChange={(copySeparators) => updateSettings({ copySeparators })}
            label="Repères de page"
            description="Insère « ——— Page 3 ——— » entre les pages lors de la copie et des exports."
          />
          <Switch
            checked={s.copyReflow}
            onChange={(copyReflow) => updateSettings({ copyReflow })}
            label="Recoller les lignes en paragraphes"
            description="Supprime les retours à la ligne de l'impression à l'intérieur d'un paragraphe (pratique pour coller dans un traitement de texte)."
          />
        </Section>

        <Section title="Hors ligne" icon={<WifiOff className="size-5 text-slate-500" aria-hidden />}>
          <ul className="mb-3 space-y-1 text-sm">
            <li>
              Interface : <strong>{offline?.appShell ? "disponible hors ligne" : "pas encore disponible hors ligne"}</strong>
            </li>
            <li>
              Reconnaissance ({LANG_OPTIONS.find((l) => l.value === s.lang)?.label}) :{" "}
              <strong>{offline?.ocr ? "disponible hors ligne" : "nécessite une connexion la première fois"}</strong>
            </li>
          </ul>
          {!offline?.ocr && (
            <Button icon={<CloudDownload className="size-5" aria-hidden />} loading={preparing} onClick={() => void prepare()}>
              Préparer l'utilisation hors ligne
            </Button>
          )}
          {!offline?.appShell && (
            <p className="mt-2 text-sm text-muted">L'interface sera disponible hors ligne après le premier chargement complet (rechargez la page une fois).</p>
          )}
        </Section>

        <Section title="Stockage sur cet appareil" icon={<HardDrive className="size-5 text-slate-500" aria-hidden />}>
          <p className="text-sm">
            Espace utilisé : <strong>{formatBytes(storage?.usage ?? null)}</strong>
            {storage?.quota ? ` sur ${formatBytes(storage.quota)} disponibles pour ce site` : ""}
          </p>
          <p className="mt-2 text-sm text-muted">
            Les documents sont enregistrés uniquement dans ce navigateur. Ils seront perdus si vous effacez les données du site, désinstallez le navigateur ou changez
            d'appareil : utilisez « Sauvegarder (.zip) » pour garder une copie.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {storage?.persisted ? (
              <p className="text-sm font-medium text-emerald-700">✓ Protégé contre l'effacement automatique</p>
            ) : (
              <Button size="sm" onClick={() => void protect()}>
                Protéger mes documents
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-red-700" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => void wipe()}>
              Tout supprimer
            </Button>
          </div>
        </Section>

        <Section title="Installer l'application" icon={<Smartphone className="size-5 text-slate-500" aria-hidden />}>
          {install.installed ? (
            <p className="text-sm text-emerald-700">✓ {APP_NAME} est installée sur cet appareil.</p>
          ) : install.canPrompt ? (
            <>
              <p className="mb-3 text-sm text-muted">Accès direct depuis l'écran d'accueil, en plein écran.</p>
              <Button variant="primary" onClick={() => void promptInstall()}>
                Installer {APP_NAME}
              </Button>
            </>
          ) : isIos() ? (
            <p className="text-sm text-muted">Sur iPhone/iPad : touchez le bouton Partager de Safari, puis « Sur l'écran d'accueil ».</p>
          ) : (
            <p className="text-sm text-muted">Utilisez le menu de votre navigateur : « Installer l'application » ou « Ajouter à l'écran d'accueil ».</p>
          )}
        </Section>

        <section className="px-1 pb-4 text-sm text-muted">
          <h2 className="mb-1 font-semibold text-ink">À propos</h2>
          <p>
            {APP_NAME} · reconnaissance locale par Tesseract {__TESSERACT_VERSION__}. Aucune image ni aucun texte n'est envoyé à un serveur. La reconnaissance peut
            commettre des erreurs (écriture manuscrite, très petits caractères, photos floues) : relisez les passages importants, en particulier les chiffres.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
