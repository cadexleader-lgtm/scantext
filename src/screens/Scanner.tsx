import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, ChevronLeft, ChevronRight, Flashlight, FlashlightOff, Images, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { CropEditor } from "../components/CropEditor";
import { AdjustControls, autoQuad, useProcessedPreview, type PreviewSource } from "../components/ImageAdjust";
import { PageThumb } from "../components/common";
import { openPicker } from "../components/ImportHost";
import { Button, IconButton } from "../components/ui";
import { cn } from "../components/ui/cn";
import { confirmAction } from "../components/ui/dialogs";
import { rgbaToGray } from "../lib/image/detect";
import { findPage } from "../lib/image/edges";
import { fullQuad } from "../lib/image/geometry";
import { drawScaled, readPixels, releaseCanvas } from "../lib/image/pipeline";
import { prepareCapture } from "../lib/import";
import { kick, suspendProcessing } from "../lib/ocr/queue";
import { goBack, navigate, paths } from "../lib/router";
import { getSettings } from "../lib/settings";
import { addPages, createDoc, getState, removePages, replacePageImage, useStore } from "../lib/store";
import { errorMessage, toast } from "../lib/toast";
import type { ImageParams, Point, Quad } from "../lib/types";

type CameraState = "starting" | "live" | "denied" | "unavailable" | "busy" | "insecure";

interface Review {
  source: PreviewSource;
  orig: { blob: Blob; w: number; h: number; thumb: Blob };
  params: ImageParams;
}

function cameraError(err: unknown): CameraState {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  return "unavailable";
}

/** Correspondance coordonnées vidéo → écran pour object-fit: cover. */
function coverMapping(vw: number, vh: number, cw: number, ch: number) {
  const s = Math.max(cw / vw, ch / vh);
  return { s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2 };
}

export function ScannerScreen({ docId: initialDocId, at, replacePageId }: { docId: string | null; at?: number; replacePageId?: string }) {
  const { pages: allPages } = useStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const docIdRef = useRef<string | null>(initialDocId);
  const insertAt = useRef<number | undefined>(at);
  const [camera, setCamera] = useState<CameraState>("starting");
  const [torch, setTorch] = useState<boolean | null>(null); // null = non disponible
  const [liveQuad, setLiveQuad] = useState<Quad | null>(null);
  const [flash, setFlash] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [cropping, setCropping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [viewer, setViewer] = useState<number | null>(null);
  /** Page à remplacer par la prochaine photo (« Reprendre »). */
  const [retake, setRetake] = useState<string | null>(replacePageId ?? null);

  const sessionPages = useMemo(() => sessionIds.map((id) => allPages[id]).filter(Boolean), [sessionIds, allPages]);
  const existingCount = initialDocId ? (getState().docs[initialDocId]?.pageIds.length ?? 0) : 0;
  const nextPageNumber = retake
    ? (getState().docs[docIdRef.current ?? ""]?.pageIds.indexOf(retake) ?? 0) + 1
    : (insertAt.current ?? existingCount + sessionIds.length) + 1;

  // ------------------------------------------------------------ caméra

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();
    if (!window.isSecureContext) return setCamera("insecure");
    if (!navigator.mediaDevices?.getUserMedia) return setCamera("unavailable");
    setCamera("starting");
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // 1920×1080 : assez pour lire une page A4, sans saturer un téléphone modeste
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch (err) {
        if (cameraError(err) !== "unavailable") throw err;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorch(caps.torch ? false : null);
      setCamera("live");
    } catch (err) {
      setCamera(cameraError(err));
    }
  }, [stopCamera]);

  // la caméra, le traitement d'image et l'OCR en même temps saturent un téléphone :
  // les pages scannées sont traitées dès la fermeture du scanner
  useEffect(() => {
    suspendProcessing("scanner", true);
    return () => suspendProcessing("scanner", false);
  }, []);

  useEffect(() => {
    void startCamera();
    return stopCamera;
  }, [startCamera, stopCamera]);

  // caméra coupée en arrière-plan (batterie), relancée au retour
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") stopCamera();
      else if (!review) void startCamera();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [review, startCamera, stopCamera]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  }

  // ------------------------------------------------------------ détection en direct

  useEffect(() => {
    if (camera !== "live" || review || viewer !== null) {
      setLiveQuad(null);
      return;
    }
    const small = document.createElement("canvas");
    let prev: Quad | null = null;
    let busy = false;
    const timer = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || busy || document.visibilityState !== "visible") return;
      busy = true;
      const scale = 200 / Math.max(v.videoWidth, v.videoHeight);
      small.width = Math.round(v.videoWidth * scale);
      small.height = Math.round(v.videoHeight * scale);
      const ctx = small.getContext("2d", { willReadFrequently: true });
      if (!ctx) return void (busy = false);
      ctx.drawImage(v, 0, 0, small.width, small.height);
      const px = readPixels(small);
      const res = findPage(rgbaToGray(px.data, px.width, px.height), px.width, px.height);
      busy = false;
      const q = res ? (res.quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad) : null;
      // lissage pour éviter que le cadre ne tremble
      prev = q && prev ? (q.map((p, i) => ({ x: prev![i].x * 0.5 + p.x * 0.5, y: prev![i].y * 0.5 + p.y * 0.5 })) as Quad) : q;
      setLiveQuad(prev);
    }, 600);
    return () => {
      clearInterval(timer);
      releaseCanvas(small);
    };
  }, [camera, review, viewer]);

  // ------------------------------------------------------------ capture

  async function ensureDoc(): Promise<string> {
    if (docIdRef.current && getState().docs[docIdRef.current]) return docIdRef.current;
    const doc = await createDoc();
    docIdRef.current = doc.id;
    return doc.id;
  }

  async function savePage(orig: Review["orig"], params: ImageParams) {
    const docId = await ensureDoc();
    if (retake && getState().pages[retake]) {
      await replacePageImage(retake, orig, params, orig.thumb);
      const replaced = retake;
      setRetake(null);
      kick();
      if (replacePageId) {
        // reprise demandée depuis la fiche d'une page : y retourner
        toast.success("Photo remplacée. Le texte va être recalculé.");
        navigate(paths.page(docId, replaced), { replace: true });
      }
      return;
    }
    const [page] = await addPages(docId, [{ source: "camera", orig, thumb: orig.thumb, params }], insertAt.current);
    if (insertAt.current !== undefined) insertAt.current++;
    setSessionIds((ids) => [...ids, page.id]);
    kick();
  }

  async function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth || saving) return;
    const frame = document.createElement("canvas");
    frame.width = v.videoWidth;
    frame.height = v.videoHeight;
    frame.getContext("2d")!.drawImage(v, 0, 0);
    setFlash((f) => f + 1);
    navigator.vibrate?.(25);
    setSaving(true);
    try {
      const cap = await prepareCapture(frame);
      const params: ImageParams = { quad: cap.quad, rotation: 0, filter: getSettings().defaultFilter, sharpen: false };
      if (getSettings().quickCapture) {
        await savePage({ blob: cap.blob, w: cap.w, h: cap.h, thumb: cap.thumb }, params);
      } else {
        const canvas = drawScaled(frame, 1100);
        setReview({ source: { canvas, w: cap.w, h: cap.h, url: URL.createObjectURL(cap.blob) }, orig: { blob: cap.blob, w: cap.w, h: cap.h, thumb: cap.thumb }, params });
        setCropping(false);
        if (videoRef.current) videoRef.current.pause();
      }
    } catch (err) {
      toast.error(errorMessage(err, "La capture a échoué."));
    } finally {
      releaseCanvas(frame);
      setSaving(false);
    }
  }

  function closeReview() {
    if (review) {
      releaseCanvas(review.source.canvas);
      URL.revokeObjectURL(review.source.url);
    }
    setReview(null);
    setCropping(false);
    void videoRef.current?.play().catch(() => undefined);
  }

  async function confirmReview(finish: boolean) {
    if (!review) return;
    setSaving(true);
    try {
      await savePage(review.orig, review.params);
      closeReview();
      if (finish) done();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function done() {
    stopCamera();
    const id = docIdRef.current;
    if (id && getState().docs[id]) navigate(paths.doc(id), { replace: !initialDocId });
    else goBack(paths.home());
  }

  async function deleteSessionPage(index: number) {
    const page = sessionPages[index];
    if (!page || !docIdRef.current) return;
    const ok = await confirmAction({ title: "Supprimer cette page ?", confirmLabel: "Supprimer", danger: true });
    if (!ok) return;
    await removePages(docIdRef.current, [page.id]);
    setSessionIds((ids) => ids.filter((id) => id !== page.id));
    if (insertAt.current !== undefined) insertAt.current--;
    setViewer(sessionPages.length > 1 ? Math.min(index, sessionPages.length - 2) : null);
  }

  // ------------------------------------------------------------ rendu

  const preview = useProcessedPreview(review?.source ?? null, review?.params ?? { quad: null, rotation: 0, filter: "color", sharpen: false });

  const v = videoRef.current;
  const stage = stageRef.current?.getBoundingClientRect();
  const overlay =
    liveQuad && v?.videoWidth && stage
      ? (() => {
          const m = coverMapping(v.videoWidth, v.videoHeight, stage.width, stage.height);
          return liveQuad.map((p: Point) => `${p.x * m.s + m.ox},${p.y * m.s + m.oy}`).join(" ");
        })()
      : null;

  const fallback = camera === "denied" || camera === "unavailable" || camera === "busy" || camera === "insecure";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white">
      {/* barre du haut */}
      <div className="safe-top relative z-10 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-6 pt-3">
        <IconButton label="Fermer le scanner" className="text-white hover:bg-white/15" onClick={done}>
          <X className="size-6" />
        </IconButton>
        <div className="min-w-0 flex-1 text-center">
          <p className="font-semibold">{retake ? `Reprendre la page ${nextPageNumber}` : `Page ${nextPageNumber}`}</p>
          <p className="text-sm text-white/75">
            {sessionIds.length
              ? `${sessionIds.length} page${sessionIds.length > 1 ? "s" : ""} scannée${sessionIds.length > 1 ? "s" : ""} · texte reconnu après le scan`
              : "Cadrez la page entière"}
          </p>
        </div>
        {torch !== null ? (
          <IconButton label={torch ? "Éteindre la lampe" : "Allumer la lampe"} className="text-white hover:bg-white/15" onClick={() => void toggleTorch()}>
            {torch ? <FlashlightOff className="size-6" /> : <Flashlight className="size-6" />}
          </IconButton>
        ) : (
          <span className="size-11" />
        )}
      </div>

      {/* zone caméra */}
      <div ref={stageRef} className="absolute inset-0">
        <video ref={videoRef} playsInline muted autoPlay className={cn("size-full object-cover", camera !== "live" && "invisible")} aria-label="Aperçu de la caméra" />
        {overlay && (
          <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
            <polygon points={overlay} fill="rgb(59 108 246 / 0.18)" stroke="#60a5fa" strokeWidth={3} strokeLinejoin="round" />
          </svg>
        )}
        {flash > 0 && <div key={flash} className="animate-flash pointer-events-none absolute inset-0 bg-white" />}
        {camera === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/80">
            <Loader2 className="size-8 animate-spin" aria-hidden />
            <p>Ouverture de la caméra…</p>
          </div>
        )}
        {fallback && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-sm rounded-3xl bg-white p-6 text-center text-ink" role="alert">
              <Camera className="mx-auto mb-3 size-10 text-brand-700" aria-hidden />
              <h2 className="text-lg font-semibold">
                {camera === "denied"
                  ? "Accès à la caméra refusé"
                  : camera === "busy"
                    ? "Caméra déjà utilisée"
                    : camera === "insecure"
                      ? "Connexion non sécurisée"
                      : "Caméra indisponible"}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {camera === "denied"
                  ? "Autorisez la caméra dans les réglages du navigateur (icône à gauche de l'adresse), ou utilisez l'appareil photo du téléphone."
                  : camera === "busy"
                    ? "Fermez les autres applications qui utilisent la caméra, puis réessayez."
                    : camera === "insecure"
                      ? "La caméra n'est accessible que sur une adresse sécurisée (https://)."
                      : "Aucune caméra utilisable n'a été trouvée sur cet appareil."}
              </p>
              <div className="mt-5 grid gap-2">
                <Button
                  variant="primary"
                  icon={<Camera className="size-5" aria-hidden />}
                  onClick={() => openPicker("camera", { docId: docIdRef.current, openAfter: true })}
                >
                  Appareil photo du téléphone
                </Button>
                <Button icon={<Images className="size-5" aria-hidden />} onClick={() => openPicker("images", { docId: docIdRef.current, at: insertAt.current, openAfter: true })}>
                  Importer des photos
                </Button>
                {camera !== "unavailable" && camera !== "insecure" && (
                  <Button variant="ghost" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void startCamera()}>
                    Réessayer
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* barre du bas */}
      <div className="safe-bottom relative z-10 mt-auto bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-10">
        {sessionPages.length > 0 && (
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1" aria-label="Pages scannées">
            {sessionPages.map((p, i) => (
              <button key={p.id} type="button" onClick={() => setViewer(i)} className="shrink-0" aria-label={`Voir la page scannée ${i + 1}`}>
                <PageThumb page={p} className="h-16 w-12 ring-2 ring-white/60" />
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 items-center">
          <div>
            <Button
              variant="dark"
              icon={<Images className="size-5" aria-hidden />}
              onClick={() => openPicker("images", { docId: docIdRef.current, at: insertAt.current, openAfter: false })}
            >
              <span className="max-sm:sr-only">Importer</span>
            </Button>
          </div>
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void capture()}
              disabled={camera !== "live" || saving}
              aria-label="Prendre la photo"
              className="flex size-20 items-center justify-center rounded-full border-4 border-white bg-white/20 transition active:scale-95 disabled:opacity-40"
            >
              {saving && !review ? <Loader2 className="size-8 animate-spin" aria-hidden /> : <span className="size-14 rounded-full bg-white" />}
            </button>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={done} disabled={saving} icon={<Check className="size-5" aria-hidden />}>
              Terminer
            </Button>
          </div>
        </div>
      </div>

      {/* vérification de la photo */}
      {review && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950" role="dialog" aria-modal="true" aria-label="Vérifier la page">
          <div className="safe-top flex items-center gap-2 px-3 py-3">
            <p className="flex-1 font-semibold">{cropping ? "Ajustez les coins sur la page" : `Vérifier la page ${nextPageNumber}`}</p>
            {preview.busy && !cropping && <Loader2 className="size-5 animate-spin text-white/70" aria-label="Calcul de l'aperçu" />}
          </div>
          <div className="relative min-h-0 flex-1 px-3">
            {cropping ? (
              <CropEditor
                src={review.source.url}
                width={review.source.w}
                height={review.source.h}
                quad={review.params.quad ?? fullQuad(review.source.w, review.source.h)}
                onChange={(quad) => setReview({ ...review, params: { ...review.params, quad } })}
              />
            ) : preview.url ? (
              <img src={preview.url} alt="Aperçu de la page recadrée" className="size-full object-contain" />
            ) : (
              <div className="flex size-full items-center justify-center">
                <Loader2 className="size-8 animate-spin" aria-hidden />
              </div>
            )}
          </div>
          <div className="safe-bottom space-y-3 px-4 pb-4 pt-3">
            <AdjustControls
              dark
              params={review.params}
              onChange={(params) => setReview({ ...review, params })}
              cropping={cropping}
              onToggleCrop={() => {
                if (!cropping && !review.params.quad) setReview({ ...review, params: { ...review.params, quad: autoQuad(review.source) ?? fullQuad(review.source.w, review.source.h) } });
                setCropping((c) => !c);
              }}
              source={review.source}
            />
            {!cropping && (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="primary" size="lg" className="col-span-2" loading={saving} icon={<Check className="size-5" aria-hidden />} onClick={() => void confirmReview(false)}>
                  {retake ? "Remplacer la page" : "Valider · page suivante"}
                </Button>
                <Button variant="dark" icon={<RefreshCw className="size-5" aria-hidden />} onClick={closeReview} disabled={saving}>
                  Reprendre
                </Button>
                <Button variant="dark" disabled={saving} onClick={() => void confirmReview(true)}>
                  Valider et terminer
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* visionneuse des pages scannées */}
      {viewer !== null && sessionPages[viewer] && (
        <PageViewer
          index={viewer}
          total={sessionPages.length}
          page={sessionPages[viewer]}
          onPrev={() => setViewer(Math.max(0, viewer - 1))}
          onNext={() => setViewer(Math.min(sessionPages.length - 1, viewer + 1))}
          onClose={() => setViewer(null)}
          onDelete={() => void deleteSessionPage(viewer)}
          onRetake={() => {
            setRetake(sessionPages[viewer].id);
            setViewer(null);
            toast("Reprenez la photo : elle remplacera cette page.");
          }}
        />
      )}
    </div>
  );
}

function PageViewer({
  index,
  total,
  page,
  onPrev,
  onNext,
  onClose,
  onDelete,
  onRetake,
}: {
  index: number;
  total: number;
  page: NonNullable<ReturnType<typeof getState>["pages"][string]>;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onDelete: () => void;
  onRetake: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950" role="dialog" aria-modal="true" aria-label={`Page scannée ${index + 1}`}>
      <div className="safe-top flex items-center gap-2 px-3 py-3">
        <IconButton label="Retour à la caméra" className="text-white hover:bg-white/15" onClick={onClose}>
          <X className="size-6" />
        </IconButton>
        <p className="flex-1 text-center font-semibold">
          Page {index + 1} / {total}
        </p>
        <span className="size-11" />
      </div>
      <div className="min-h-0 flex-1 px-3">
        <PageThumb page={page} className="size-full bg-transparent ring-0" />
      </div>
      <div className="safe-bottom grid grid-cols-2 gap-2 px-4 pb-4 pt-3 sm:grid-cols-4">
        <Button variant="dark" icon={<ChevronLeft className="size-5" aria-hidden />} disabled={index === 0} onClick={onPrev}>
          Page précédente
        </Button>
        <Button variant="dark" disabled={index === total - 1} onClick={onNext}>
          Page suivante <ChevronRight className="size-5" aria-hidden />
        </Button>
        <Button variant="dark" icon={<RefreshCw className="size-5" aria-hidden />} onClick={onRetake}>
          Reprendre
        </Button>
        <Button variant="danger" icon={<Trash2 className="size-5" aria-hidden />} onClick={onDelete}>
          Supprimer
        </Button>
      </div>
    </div>
  );
}
