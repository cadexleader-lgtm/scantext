# ScanText — scan et transcription de documents (PWA)

Application web progressive qui transforme des documents papier, des photos et des PDF en **texte modifiable**, directement sur l'appareil : scan multi-pages à la caméra, reconnaissance de texte (OCR) locale, éditeur, « Copier tout » en un clic, exports TXT / DOCX / PDF / PDF recherchable.

- **Aucun compte**, aucun serveur applicatif : les images et le texte ne quittent jamais l'appareil.
- **Interface en français**, pensée pour le téléphone (Android modeste inclus) et adaptée à l'ordinateur.
- **Installable** (PWA) et **utilisable hors ligne** après le premier chargement.

**Application en ligne : https://cadexleader-lgtm.github.io/scantext/** (à ouvrir sur le téléphone, puis « Ajouter à l'écran d'accueil »).

> Nom provisoire : il se change en une ligne dans `src/config.ts` (`APP_NAME`) — interface, titre, manifeste PWA et noms de fichiers suivent.

---

## Démarrage

Prérequis : Node.js 20 ou plus récent.

```bash
cd scantext
npm install
npm run dev        # http://localhost:5173 (copie automatiquement les fichiers OCR)
```

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de développement (service worker désactivé) |
| `npm run build` | Vérification des types + build de production dans `dist/` |
| `npm run preview` | Sert `dist/` (http://localhost:4173), service worker actif |
| `npm run typecheck` / `npm run lint` | TypeScript strict / ESLint |
| `npm test` | Tests unitaires (Vitest, 65 tests) |
| `npm run e2e` | Tests de bout en bout dans Chromium (voir « Tests ») |
| `npm run bench` | Banc de précision de la reconnaissance (voir « Précision mesurée ») |

`npm run dev` et `npm run build` exécutent d'abord `scripts/copy-ocr-assets.mjs`, qui copie le moteur Tesseract et les langues depuis `node_modules` vers `public/tesseract/` (dossier généré, non versionné).

La caméra n'est accessible que dans un **contexte sécurisé** : `https://` ou `http://localhost`. Pour tester sur un téléphone pendant le développement, utilisez un tunnel HTTPS (ex. `cloudflared tunnel --url http://localhost:5173`) ou déployez une préversion.

---

## Fonctionnalités

**Terminé et testé**

- Accueil : nouveau document, scanner avec la caméra, importer des photos, importer un PDF, documents récents (nombre de pages + statut).
- **Scan caméra multi-pages** : flux continu sans revenir à l'accueil (le traitement d'image et l'OCR attendent la fermeture du scanner pour ne pas ralentir la caméra), détection des contours en direct, écran de vérification (filtres, rotation, netteté, recadrage manuel avec loupe), « Valider · page suivante », miniatures, visionneuse « Page précédente / suivante / Reprendre / Supprimer », lampe torche si disponible, mode « Scan rapide » sans vérification.
- **Repli sans caméra** (refus d'autorisation, caméra absente ou occupée, site non HTTPS) : message clair + appareil photo natif du téléphone + import de photos.
- **Traitement d'image** (Web Worker) : détection automatique de la feuille **par ses contours** (le texte est d'abord effacé par une fermeture morphologique, puis les longs bords droits sont cherchés par transformée de Hough ; chaque cadre candidat est noté selon la présence réelle d'un bord sur ses 4 côtés — fonctionne aussi sur un fond clair ou texturé), **correction de perspective avec estimation des vraies proportions** (une page A4 photographiée de biais reste au format A4), filtres Document / Gris / Noir & blanc / Couleur, suppression des ombres.
- **Redressement des lignes** : les lignes de texte sont repérées sur la page (caractères voisins enchaînés, une courbe par ligne) ; l'inclinaison est corrigée par une rotation et la courbure (page bombée, feuille gondolée) par un champ de déplacement interpolé entre les lignes. Option « Lignes droites » dans *Recadrer, filtres* (active par défaut).
- **Image préparée pour la lecture** (worker, à chaque reconnaissance, l'image vue par l'utilisateur n'est pas modifiée) : fond uniformisé, taille des caractères mesurée puis **agrandissement bicubique** pour que les minuscules mesurent ≈ 24 px (≈ 300 dpi), **règles de tableau, soulignements et traits parasites effacés** (bord d'une autre feuille, pli — un trait n'est effacé qu'en dehors des lettres qu'il traverse), zones sombres collées au bord blanchies. Une page sans lignes de texte (photo, image bruitée) n'est ni agrandie ni retouchée.
- **OCR réel** (Tesseract.js 7, WebAssembly, local) : français + anglais par défaut, ou une seule langue ; ordre de lecture et paragraphes reconstruits d'après la géométrie (morceaux d'une même ligne recollés en suivant leur ligne de base, colonnes conservées, puces « • » reconnues) ; **seconde passe automatique** quand des caractères de l'image n'ont été lus par aucun mot (une colonne de tableau oubliée par le découpage de la page, un texte isolé) ; statuts En attente / En cours / Terminé / Erreur / À vérifier ; progression « 8 pages sur 20 traitées » ; pause / reprise ; relance d'une seule page ; reprise automatique après fermeture ou rechargement ; écran maintenu allumé pendant le traitement ; pages vides et résultats incertains signalés (aucun texte inventé).
- **Tableaux** : un tableau à traits est reconstruit d'après sa grille (chaque mot dans sa case, cases fusionnées respectées) ; un tableau sans traits est repéré par ses colonnes de blanc (en lecture automatique seulement s'il a des cases courtes, pour ne pas confondre avec un texte en colonnes ; plus largement avec l'option « Tableaux et formulaires »). Dans le texte, une rangée = une ligne, cases séparées par des tabulations : **collé dans Excel, Google Sheets, Word ou Docs, le tableau garde ses colonnes** (« Copier tout » et « Copier » envoient aussi une version HTML avec de vraies cases). Sous le texte de la page, chaque tableau est **modifiable case par case**. Exports : vrais tableaux Word (DOCX), tableaux dessinés dans le PDF du texte.
- **Relecture guidée** : bouton « Relire (N) » sur chaque page reconnue ; chaque mot dont la confiance est inférieure à 80 % est montré **sur un extrait de la photo** (mot encadré), à corriger ou confirmer (« C'est juste »), puis le suivant. Fonctionne aussi après des corrections à la main : les mots du texte courant sont alignés sur les mots reconnus.
- **PDF importés** : rendu des pages ; si le PDF contient déjà du texte, choix « Utiliser le texte du PDF » (exact) ou « Refaire l'OCR ».
- **Pages** : réordonner (flèches, glisser-déposer sur ordinateur), insérer avant/après ou n'importe où, supprimer, recadrer/filtrer après coup, reprendre la photo.
- **Éditeur** : mode *Texte continu* (toutes les pages à la suite, repères masquables) et mode *Par page* (image et texte côte à côte sur ordinateur, onglets sur téléphone) ; recherche insensible aux accents, remplacer / tout remplacer ; mots incertains surlignés.
- **Les corrections manuelles ne sont jamais remplacées silencieusement** : relancer l'OCR d'une page corrigée propose la nouvelle version (« Garder ma version » / « Remplacer »).
- **Copier tout** : texte réel de toutes les pages dans l'ordre, options « séparateurs de page » et « recoller les lignes en paragraphes » ; repli si le presse-papiers est refusé (sélection manuelle ou téléchargement .txt).
- **Exports** avec nom de fichier modifiable : TXT (UTF-8), DOCX « Texte simple » ou « Mise en page approchée » (titres, alignements, retraits ; images des pages en option), PDF du texte, **PDF recherchable** (image + couche de texte invisible : chaque mot est étiré à la largeur exacte du mot photographié, sur sa ligne de base, suivi d'une espace qui va jusqu'au mot suivant — sélection, copie et Ctrl+F tombent sur le bon mot ; un texte corrigé à la main est recalé mot par mot sur les positions reconnues). Partage natif sur mobile.
- **Sauvegarde automatique** (IndexedDB), renommer, dupliquer, supprimer avec confirmation, **sauvegarde/restauration de projet en .zip**, indicateur d'espace utilisé, protection contre l'effacement automatique (`navigator.storage.persist`), message clair si le stockage est plein.
- **PWA** : manifeste, icônes, service worker, installation, interface et exports hors ligne, OCR hors ligne une fois ses fichiers téléchargés (statut honnête dans Paramètres + bouton « Préparer l'utilisation hors ligne »), notification de nouvelle version.

**Reste à développer / pistes**

- Capture automatique quand le cadre est stable, et détection de pages doubles (livre ouvert).
- Détection automatique de l'orientation (texte à l'envers) : demande le modèle « legacy » de Tesseract (+10 Mo) ; aujourd'hui, rotation manuelle.
- Langues supplémentaires (il suffit d'ajouter les paquets `@tesseract.js-data/<langue>` et de les déclarer dans `scripts/copy-ocr-assets.mjs` et `LANG_OPTIONS`).
- Police Unicode embarquée dans les PDF exportés (actuellement Helvetica standard, voir Limites).
- Tableaux sans traits dont une case occupe plusieurs lignes de texte décalées : la rangée peut être coupée en deux.
- Capture à pleine résolution du capteur pendant le scan (`ImageCapture.takePhoto`), aujourd'hui limitée à la résolution du flux vidéo.
- OCR distant optionnel (meilleure précision sur l'écriture manuscrite) — **non implémenté** ; s'il est ajouté, il doit rester facultatif, passer par un serveur qui garde la clé API, et l'envoi doit être explicitement demandé par l'utilisateur.

---

## Architecture

```
scantext/
  src/
    config.ts                 Nom du produit, couleurs, extension de sauvegarde
    main.tsx, App.tsx         Démarrage, routage par ancre (#/...), hôtes globaux
    screens/                  Home, Documents, Settings, DocumentScreen, Scanner, Editor, PageScreen
    components/               AppShell, CropEditor, ImageAdjust, PageText, CopyAllButton,
                              ExportDialog, ImportHost (sélecteurs de fichiers), ui/ (boutons, dialogues…)
    lib/
      store.ts                État en mémoire + écritures IndexedDB (sérialisées, différées pour la frappe)
      db.ts                   Schéma IndexedDB : docs / pages / blobs (images séparées des métadonnées)
      image/                  geometry (homographie, proportions), detect + edges (contours), ops (perspective,
                              filtres), straighten (lignes penchées/courbées), components (composantes connexes),
                              ocr-prep (agrandissement, traits effacés), png, process.worker.ts, pipeline
      ocr/                    engine (Tesseract, seconde passe), queue (file image → OCR), layout (paragraphes),
                              tables (grilles, colonnes de blanc), align (texte corrigé ↔ mots reconnus), apply (règles)
      pdf/import.ts           pdf.js : rendu des pages + extraction du texte intégré
      export/                 builders (TXT, DOCX, PDF, PDF recherchable), project (.zip), download/partage
      text.ts                 Assemblage, recollage des lignes, recherche sans accents, noms de fichiers
      text-blocks.ts          Paragraphes et tableaux d'un texte (tabulations), HTML du presse-papiers
      settings.ts, offline.ts, pwa.ts, storage.ts, clipboard.ts, router.ts, toast.ts
  scripts/copy-ocr-assets.mjs Copie moteur + langues OCR dans public/tesseract/
  scripts/gen-icons.cjs       Génère les icônes PNG (à relancer seulement si le logo change)
  tests/                      Tests unitaires (Vitest)
  e2e/                        Tests de bout en bout (Playwright) + génération des fichiers de test
  bench/                      Banc de précision (pages de test générées, chaîne avant / maintenant)
```

**Flux d'une page** : capture ou import → image d'origine réduite à la qualité choisie et enregistrée → la file de traitement prépare l'image (worker : perspective, rotation, redressement des lignes, filtre) → au moment de la lecture, une copie agrandie et nettoyée est préparée (worker) puis lue par Tesseract ; les positions des mots sont ramenées à l'image traitée → paragraphes et tableaux reconstruits → le texte est enregistré. Chaque étape est persistée : une interruption reprend à la page en cours. Une modification de l'image relance l'OCR ; si le texte avait été corrigé, la nouvelle reconnaissance est seulement *proposée*.

**Performances** : bundle initial ≈ 110 Ko gzip ; pdf.js, docx, pdf-lib, fflate, les écrans scanner/éditeur et Tesseract sont chargés à la demande. Le moteur OCR (≈ 1,4 Mo gzip pour la variante choisie selon le support SIMD) et la langue (0,7 Mo français, 2,9 Mo anglais) ne sont téléchargés qu'au premier usage puis mis en cache. Le moteur est libéré après 90 s d'inactivité (mémoire des téléphones modestes).

### Dépendances et justification

| Paquet | Pourquoi |
|---|---|
| `react`, `react-dom` | Interface (React 19) |
| `tesseract.js` + `@tesseract.js-data/fra`, `/eng` | OCR local en WebAssembly, bien maintenu, Web Worker intégré ; modèles « best_int » (meilleure précision/poids), servis par l'application (pas de CDN tiers) |
| `wasm-feature-detect` | Savoir quelle variante du moteur (SIMD) mettre en cache pour le hors ligne |
| `pdfjs-dist` (build « legacy ») | Lecture fiable des PDF, texte intégré inclus ; build « legacy » pour une compatibilité plus large avec les navigateurs anciens |
| `docx` | Génère de vrais fichiers Word (OOXML) modifiables |
| `pdf-lib` | Génère les PDF (texte, et images + couche de texte invisible) |
| `fflate` | Zip rapide et léger pour la sauvegarde de projet |
| `idb` | Petite surcouche promesse d'IndexedDB |
| `lucide-react` | Icônes cohérentes (importées à l'unité) |
| `tailwindcss`, `vite`, `vite-plugin-pwa` (dev) | Styles, build, service worker Workbox + manifeste |
| `vitest`, `fake-indexeddb`, `eslint`, `typescript` (dev) | Qualité et tests |

Volontairement absents : OpenCV.js (≈ 8 Mo — la détection des contours, la perspective, le redressement des lignes et les filtres tiennent en ~2 500 lignes testées), une bibliothèque de composants lourde (dialogues natifs `<dialog>`, accessibles), un routeur (routage par ancre maison, compatible avec tout hébergement statique).

---

## Déploiement HTTPS

`npm run build` produit un site **statique** dans `dist/` (chemins relatifs : fonctionne à la racine d'un domaine ou dans un sous-dossier). N'importe quel hébergeur statique en HTTPS convient.

- **GitHub Pages (en place)** : `.github/workflows/deploy.yml` lance la vérification des types, les tests et le build à chaque modification de `main`, puis publie `dist/` sur la branche `gh-pages`. Réglage unique dans le dépôt : *Settings → Pages → Source : Deploy from a branch → `gh-pages` / (root)*.
- **Cloudflare Pages** : commande de build `cd scantext && npm ci && npm run build`, dossier de sortie `scantext/dist`.
- **Netlify / Vercel** : répertoire de base `scantext`, commande `npm run build`, dossier `dist`.
- **GitHub Pages** : publier le contenu de `dist/` (aucune réécriture d'URL nécessaire grâce au routage `#/`).

Points d'attention :

1. **HTTPS obligatoire** pour la caméra, le presse-papiers et le service worker.
2. Ne pas mettre en cache longue durée `sw.js` et `index.html` (les fichiers de `assets/` sont versionnés par leur nom et peuvent l'être).
3. Les fichiers `tesseract/lang/*.traineddata.gz` doivent être servis **tels quels** (pas d'en-tête `Content-Encoding: gzip` ajouté par le serveur) : Tesseract.js les décompresse lui-même. C'est en général le comportement par défaut des hébergeurs statiques ; à vérifier si la reconnaissance échoue au premier chargement.
4. Aucun secret ni variable d'environnement n'est nécessaire.

---

## Confidentialité et sécurité

- Tout le traitement (image, OCR, exports) est fait **dans le navigateur**. Aucune requête réseau ne transporte d'image ou de texte ; les seuls téléchargements sont les fichiers de l'application elle-même.
- Données stockées uniquement dans IndexedDB sur l'appareil ; « Paramètres → Tout supprimer » efface tout.
- Permissions demandées : caméra (uniquement à l'ouverture du scanner), presse-papiers (au clic sur « Copier tout »), stockage persistant (sur demande).
- **Le stockage du navigateur n'est pas une sauvegarde garantie** (effacement des données du site, changement d'appareil, navigation privée) : l'application le dit à l'accueil et dans les paramètres, et propose la sauvegarde .zip.

---

## Limites connues

**OCR**

- Tesseract reconnaît bien le texte **imprimé** ; l'**écriture manuscrite** est en général mal reconnue.
- La qualité dépend de la photo : flou, faible lumière, reflets, très petits caractères (< 8 pt sur une photo de téléphone) dégradent le résultat. Le mode « Haute » qualité et l'appareil photo natif du téléphone aident.
- Les puces typographiques (•) sont souvent lues comme « e » ou « « ». Les chiffres sont conservés tels que reconnus, sans correction automatique : **relisez les montants, dates et références**.
- Aucune reconnaissance n'est parfaite : la relecture guidée sert à vérifier les mots douteux, mais un mot mal lu avec une confiance élevée ne sera pas proposé. **Relisez toujours les montants, dates et références.**
- Mise en page : les colonnes de texte sont lues l'une après l'autre (mode automatique). Tableaux : bien reconstruits avec des traits ; sans traits, les cases sur plusieurs lignes décalées peuvent être coupées. Le DOCX « mise en page approchée » ne reproduit pas fidèlement une mise en page complexe.
- Redressement : corrige une inclinaison jusqu'à 15° et une courbure régulière ; une page très déformée (pli marqué, coin corné) ne l'est que partiellement. Un trait parasite qui traverse les lettres est laissé là où il les croise (l'effacer emporterait des morceaux de lettres).
- Orientation : une page photographiée à l'envers doit être pivotée à la main.
- Vitesse : environ 1,5 à 4 s par page sur un ordinateur récent (mesuré, image agrandie et deux langues), nettement plus sur un téléphone d'entrée de gamme (non mesuré ici). « Français » seul est un peu plus rapide. Les navigateurs mobiles suspendent le traitement quand l'application passe en arrière-plan ; il reprend au retour.

**Application**

- Détection des contours : s'appuie sur les bords droits de la feuille. Une page très courbée (livre épais), pliée, ou dont un bord est caché par la main peut être mal cadrée : le recadrage manuel (coins déplaçables avec loupe) reste disponible. Sans bord net, l'image entière est gardée plutôt qu'un cadre inventé.
- La correction des proportions suppose une photo non recadrée (centre optique au centre de l'image).
- PDF exportés : police standard Helvetica — les caractères hors alphabet latin (grec, cyrillique, arabe, chinois…) sont remplacés par « ? » (signalé dans la fenêtre d'export). Le TXT et le DOCX ne sont pas concernés.
- PDF recherchable : un mot **ajouté** à la main est rattaché au mot reconnu qui le précède ; une page sans mots reconnus (texte saisi, texte d'un PDF) reçoit un placement approché.
- iPhone/iPad : l'installation se fait via « Partager → Sur l'écran d'accueil » (aucun navigateur iOS ne permet l'installation par bouton) ; le flux vidéo du navigateur a souvent une résolution inférieure à celle de l'appareil photo : l'option « Appareil photo du téléphone » donne la meilleure qualité, sur iOS comme sur Android.
- Le partage de fichier natif exige un geste récent : si la préparation est longue, un second appui « Partager maintenant » est demandé.

---

## Tests

### Précision mesurée — `npm run bench`

Taux de mots erronés (plus bas = mieux), chaîne d'origine contre chaîne actuelle, mêmes images, Tesseract français + anglais :

| Page | Avant | Maintenant |
|---|---|---|
| Photo réelle de l'utilisateur (page de cours, légèrement courbée, trait parasite, bord sombre) | 9,9 % | **1,1 %** |
| Même feuille, photo penchée et bombée | 48,2 % | **2,4 %** |
| Page de test nette | 0,0 % | 0,0 % |
| Page de test penchée de 2° et bombée | 5,6 % | **0,0 %** |
| Page de test basse résolution (≈ 110 dpi) et floue | 0,9 % | 0,9 % |
| Page de test traversée par un trait parasite | 5,6 % | 5,6 % |
| Facture de test, tableau à traits (cases fausses) | 31,3 % | **6,3 %** |

Les deux premières lignes ont été mesurées sur des captures d'écran de l'application (résolution inférieure à la photo réelle), avec le texte exact de la page saisi à la main ; ces images ne sont pas versionnées. `npm run bench` régénère et mesure les pages de test (navigateur Chromium nécessaire, `BENCH_LANG=fra` pour une seule langue, `VERBOSE=1` pour voir le texte).

### Tests unitaires — `npm test` (65 tests, Vitest)

Redressement des lignes (inclinaison mesurée et corrigée, page bombée aplatie), préparation de l'image (règles de tableau repérées et effacées, trait oblique effacé, agrandissement bicubique, PNG), tableaux (grille avec case fusionnée, tableau sans traits découpé en colonnes par le moteur, texte en deux colonnes non confondu avec un tableau, tabulations dans le texte, HTML du presse-papiers), seconde passe sur les zones oubliées, alignement d'un texte corrigé sur les mots reconnus, **position exacte des mots dans le PDF recherchable** (relu par pdf.js), géométrie (homographie, quadrilatère, **proportions réelles en perspective**), détection de document sur photos synthétiques (fond sombre, **tissu clair texturé, table presque blanche, tableau dans la page, feuille plus large que le cadre, absence de feuille**), ordre de lecture (morceaux recollés, colonnes, puces), perspective/rotation/filtres, assemblage du texte et recollage des lignes, recherche sans accents, noms de fichiers, règles OCR (jamais écraser une correction), reconstruction des paragraphes, exports TXT/DOCX/PDF/PDF recherchable générés puis relus, store IndexedDB (captures simultanées, insertion, déplacement, suppression, corrections persistées, reprise après interruption, duplication).

### Tests de bout en bout — 21 scénarios dans Chromium

```bash
npm run build
npx vite preview --port 4173 &
node e2e/fixtures.cjs     # pages imprimées, photo en perspective, facture à tableaux, page blanche, bruit, PDF, flux caméra
npm run e2e               # ou : node e2e/run.mjs "Scan caméra"  (filtre par nom)
```

Les scénarios tournent sur la **version de production** (service worker actif), avec le vrai moteur OCR, de vrais fichiers et une caméra simulée par Chromium (`--use-file-for-fake-video-capture`, flux d'une photo de page en perspective). Captures d'écran dans `e2e/.out/screens/`.

| # demandé | Scénario | Résultat |
|---|---|---|
| 1 | Page imprimée → texte exploitable (accents, « 137,50 € », références exacts, confiance ≥ 80 %) | ✅ |
| 2-3 | 20 pages importées, réunies dans le bon ordre | ✅ |
| 4 | « Copier tout » : 20 pages dans l'ordre (presse-papiers relu), option séparateurs | ✅ |
| 5-6 | Correction dans l'éditeur, actualisation : correction conservée ; recherche sans accents | ✅ |
| — | Relancer l'OCR d'une page corrigée : proposition, correction intacte, « Garder ma version » | ✅ |
| 7 | Export TXT (nom personnalisé, BOM, contenu, ordre, correction incluse) | ✅ |
| 8 | Export DOCX simple + mise en page approchée (structure OOXML, texte, sauts de page, titres en gras) | ✅ |
| 9 | Export PDF texte + PDF recherchable (fichiers relus par pdf.js, texte extractible, images présentes) | ✅ |
| 10 | Import PDF texte (texte exact réutilisé) + PDF scanné (OCR) | ✅ |
| 11 | Supprimer une page, réordonner (ordre vérifié en base) | ✅ |
| 12 | Pause, reprise, rechargement en plein traitement → toutes les pages terminées | ✅ |
| 13 | Caméra refusée : message + 3 solutions de repli, import de repli fonctionnel | ✅ |
| — | **Scan caméra** 3 captures (dont recadrage manuel), visionneuse précédent/suivant, suppression, contours détectés, proportions A4 retrouvées, texte reconnu | ✅ |
| — | Photo en perspective importée : recadrage auto, proportions, OCR | ✅ |
| — | Feuille sur tissu gris clair (fond proche du papier) : cadre sans le fond, proportions A4, OCR — échouait avant la détection par contours | ✅ |
| 14 | Page blanche → « Page vide », image de bruit → vide ou « À vérifier », aucun texte inventé | ✅ |
| 15 + 17 | Écran 360 px : aucun défilement horizontal sur 5 écrans, aucun bouton sans nom accessible | ✅ |
| 16 | Hors ligne : rechargement sans réseau, documents visibles, **nouvel OCR hors ligne**, export DOCX hors ligne | ✅ |
| — | **Tableaux** : facture photographiée de travers → tableau à traits (case fusionnée « Total hors taxes ») et tableau sans traits reconstruits dans l'ordre, case modifiée dans la grille, « Copier tout » avec colonnes, 2 vrais tableaux Word, PDF du texte | ✅ |
| — | **Relecture** : mot douteux montré sur l'extrait de photo, corrigé en place, page marquée corrigée | ✅ |
| — | Sauvegarde .zip puis restauration | ✅ |

**Non testé (honnêtement)** : appareils physiques (iPhone, Android d'entrée de gamme), vraie caméra matérielle, Safari et Firefox, documents réels de 100 pages sur téléphone (mémoire / temps), écriture manuscrite. Ces vérifications restent à faire sur le terrain avant une mise en production.
