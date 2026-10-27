/** Statut de reconnaissance d'une page. */
export type OcrStatus = "pending" | "processing" | "done" | "error" | "review";
/** Statut de préparation de l'image (recadrage, filtre) d'une page. */
export type ImageStatus = "pending" | "ready" | "error";
export type FilterId = "color" | "gray" | "enhanced" | "bw";
export type Rotation = 0 | 90 | 180 | 270;
export type OcrLang = "fra" | "eng" | "fra+eng";
/** auto = colonnes détectées séparément ; table = lignes conservées (tableaux, formulaires). */
export type LayoutMode = "auto" | "table";
export type PageSource = "camera" | "image" | "pdf";

export interface Point {
  x: number;
  y: number;
}
/** Coins du document dans l'image d'origine : haut-gauche, haut-droite, bas-droite, bas-gauche. */
export type Quad = [Point, Point, Point, Point];
export type BBox = [number, number, number, number]; // x0, y0, x1, y1

export interface OcrWord {
  t: string;
  /** Confiance 0-100. */
  c: number;
  b: BBox;
}
export interface OcrLine {
  b: BBox;
  words: OcrWord[];
  /** Ligne de base (x0, y0, x1, y1), si connue. */
  bl?: BBox;
  /** Hauteur de la ligne (des jambages bas au haut des majuscules), si connue. */
  rh?: number;
}
/** Case d'un tableau (r, c : rangée et colonne de départ ; rs, cs : cases fusionnées). */
export interface OcrCell {
  r: number;
  c: number;
  rs: number;
  cs: number;
  b: BBox;
  words: OcrWord[];
}
export interface OcrTable {
  b: BBox;
  nr: number;
  nc: number;
  cells: OcrCell[];
  /** Tableau délimité par des traits (sinon : colonnes déduites des blancs). */
  ruled: boolean;
}
export interface OcrParagraph {
  b: BBox;
  /** Pour un tableau : une ligne par case, dans l'ordre des cases. */
  lines: OcrLine[];
  table?: OcrTable;
}
/** Structure détectée par l'OCR, en pixels de l'image traitée. */
export interface OcrLayout {
  w: number;
  h: number;
  paragraphs: OcrParagraph[];
}

export interface DocRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
  lang: OcrLang;
  layoutMode: LayoutMode;
}

export interface ImageParams {
  quad: Quad | null;
  rotation: Rotation;
  filter: FilterId;
  sharpen: boolean;
  /** Redresse les lignes de texte penchées ou courbées (absent = oui). */
  straighten?: boolean;
}

export interface PageRecord extends ImageParams {
  id: string;
  docId: string;
  createdAt: number;
  updatedAt: number;
  source: PageSource;
  origW: number;
  origH: number;

  imageStatus: ImageStatus;
  imageError: string | null;
  /** Incrémenté à chaque nouvelle image traitée : une reconnaissance faite sur une ancienne image est périmée. */
  imageRev: number;
  procW: number;
  procH: number;
  /** Version de la chaîne de traitement d'image qui a produit l'image traitée. */
  procVersion?: number;

  ocrStatus: OcrStatus;
  ocrError: string | null;
  ocrConfidence: number | null;
  /** imageRev sur laquelle la reconnaissance actuelle a été faite. */
  ocrRev: number | null;
  ocrLang: OcrLang | null;
  /** Dernier texte brut reconnu (ou extrait du PDF). */
  ocrText: string | null;
  /** Texte courant, modifiable par l'utilisateur. */
  text: string;
  /** Vrai si le texte diffère du résultat brut : il ne doit jamais être remplacé sans accord. */
  edited: boolean;
  /** Nouvelle reconnaissance en attente de décision, quand la page avait été corrigée à la main. */
  pendingText: string | null;
  /** Aucun texte détecté sur la page. */
  blank: boolean;
  layout: OcrLayout | null;
  textSource: "ocr" | "pdf" | null;
  /** Pour une page importée d'un PDF qui contient déjà du texte. */
  pdfText: string | null;
}
