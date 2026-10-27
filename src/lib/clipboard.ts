/**
 * Copie un texte (éventuellement très long) dans le presse-papiers.
 * Doit être appelé directement depuis un geste de l'utilisateur (clic).
 * @throws si aucune méthode n'a fonctionné
 */
export async function copyText(text: string, html?: string): Promise<"clipboard" | "legacy"> {
  // texte + HTML : un tableau collé dans Word, Docs ou un tableur garde ses cases
  if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write && window.isSecureContext) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return "clipboard";
    } catch {
      // format riche refusé : copie du texte seul
    }
  }
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // permission refusée ou API indisponible : méthode de secours
    }
  }
  if (legacyCopy(text)) return "legacy";
  throw new Error("La copie automatique n'est pas autorisée par ce navigateur.");
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.fontSize = "16px"; // évite le zoom sur iOS
  document.body.appendChild(ta);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}
