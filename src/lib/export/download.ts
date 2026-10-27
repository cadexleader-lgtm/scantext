/** Télécharge un fichier généré dans le navigateur. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // laisser le temps au navigateur de démarrer le téléchargement
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(): boolean {
  try {
    if (typeof navigator.canShare !== "function") return false;
    const probe = new File(["x"], "test.txt", { type: "text/plain" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Partage via la feuille de partage du système (mobile). Retourne false si annulé. */
export async function shareBlob(blob: Blob, filename: string, title: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  if (!navigator.canShare?.({ files: [file] })) throw new Error("Le partage de fichiers n'est pas disponible sur cet appareil.");
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return false;
    throw err;
  }
}
