import { lazy, Suspense, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { ImportHost } from "./components/ImportHost";
import { Button, Spinner } from "./components/ui";
import { DialogHost } from "./components/ui/dialogs";
import { Toaster } from "./components/ui/Toaster";
import { APP_NAME } from "./config";
import { navigate, paths, useRoute } from "./lib/router";
import { useStore } from "./lib/store";
import { HomeScreen } from "./screens/Home";
import { DocumentsScreen } from "./screens/Documents";
import { SettingsScreen } from "./screens/Settings";
import { DocumentScreen } from "./screens/DocumentScreen";

// écrans lourds chargés à la demande
const ScannerScreen = lazy(() => import("./screens/Scanner").then((m) => ({ default: m.ScannerScreen })));
const EditorScreen = lazy(() => import("./screens/Editor").then((m) => ({ default: m.EditorScreen })));
const PageScreen = lazy(() => import("./screens/PageScreen").then((m) => ({ default: m.PageScreen })));

function FullScreenMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertTriangle className="size-10 text-amber-600" aria-hidden />
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Chargement">
      <Spinner className="size-8" />
    </div>
  );
}

function Routes() {
  const route = useRoute();
  const { loaded, loadError, docs } = useStore();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name]);
  useEffect(() => {
    const titles: Record<string, string> = { home: APP_NAME, documents: "Mes documents", settings: "Paramètres", scan: "Scanner" };
    const docName = "docId" in route && route.docId ? docs[route.docId]?.name : undefined;
    document.title = docName ? `${docName} · ${APP_NAME}` : titles[route.name] ? `${titles[route.name]} · ${APP_NAME}` : APP_NAME;
  }, [route, docs]);

  if (!loaded) return <Loading />;
  if (loadError)
    return (
      <FullScreenMessage title="Stockage indisponible">
        <p className="max-w-md text-muted">{loadError}</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Réessayer
        </Button>
      </FullScreenMessage>
    );

  const missingDoc = "docId" in route && route.docId && !docs[route.docId];
  if (missingDoc)
    return (
      <FullScreenMessage title="Document introuvable">
        <p className="max-w-md text-muted">Ce document n'existe pas ou a été supprimé de cet appareil.</p>
        <Button variant="primary" onClick={() => navigate(paths.documents(), { replace: true })}>
          Mes documents
        </Button>
      </FullScreenMessage>
    );

  switch (route.name) {
    case "home":
      return <HomeScreen />;
    case "documents":
      return <DocumentsScreen />;
    case "settings":
      return <SettingsScreen />;
    case "doc":
      return <DocumentScreen key={route.docId} docId={route.docId} />;
    case "editor":
      return <EditorScreen key={route.docId} docId={route.docId} initialPageId={route.pageId} />;
    case "scan":
      return <ScannerScreen key={`${route.docId}-${route.at}-${route.replace}`} docId={route.docId} at={route.at} replacePageId={route.replace} />;
    case "page":
      return <PageScreen key={route.pageId} docId={route.docId} pageId={route.pageId} />;
    default:
      return (
        <FullScreenMessage title="Page introuvable">
          <Button variant="primary" onClick={() => navigate(paths.home(), { replace: true })}>
            Retour à l'accueil
          </Button>
        </FullScreenMessage>
      );
  }
}

export function App() {
  return (
    <>
      <Suspense fallback={<Loading />}>
        <Routes />
      </Suspense>
      <ImportHost />
      <DialogHost />
      <Toaster />
    </>
  );
}
