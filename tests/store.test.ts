import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import * as db from "../src/lib/db";
import * as store from "../src/lib/store";
import type { NewPageInput } from "../src/lib/store";

const input = (n: number): NewPageInput => ({
  source: "camera",
  orig: { blob: new Blob([`img-${n}`], { type: "image/jpeg" }), w: 100, h: 140 },
  params: { quad: null, rotation: 0, filter: "enhanced", sharpen: false },
});
const docText = (docId: string) => store.getDocPages(docId).map((p) => p.text);

beforeEach(async () => {
  await store.initStore();
  await store.clearAllData();
});

describe("store + IndexedDB", () => {
  it("captures rapides simultanées : aucune page perdue, ordre conservé", async () => {
    const doc = await store.createDoc("Test");
    const added = await Promise.all([1, 2, 3, 4, 5].map((n) => store.addPages(doc.id, [input(n)])));
    const ids = added.map(([p]) => p.id);
    expect(store.getState().docs[doc.id].pageIds).toEqual(ids);
    // relu depuis le disque
    const { docs } = await db.loadAll();
    expect(docs.find((d) => d.id === doc.id)!.pageIds).toEqual(ids);
    expect(await (await db.getBlob(ids[2], "orig"))!.text()).toBe("img-3");
  });

  it("insertion au milieu, déplacement, suppression", async () => {
    const doc = await store.createDoc();
    const [a, b, c] = await store.addPages(doc.id, [input(1), input(2), input(3)]);
    const [x] = await store.addPages(doc.id, [input(9)], 1);
    expect(store.getState().docs[doc.id].pageIds).toEqual([a.id, x.id, b.id, c.id]);
    await store.movePage(doc.id, c.id, 0);
    expect(store.getState().docs[doc.id].pageIds).toEqual([c.id, a.id, x.id, b.id]);
    await store.removePages(doc.id, [x.id]);
    expect(store.getState().docs[doc.id].pageIds).toEqual([c.id, a.id, b.id]);
    expect(await db.getBlob(x.id, "orig")).toBeUndefined();
  });

  it("corrections enregistrées sur l'appareil et marquées « corrigées »", async () => {
    const doc = await store.createDoc();
    const [p] = await store.addPages(doc.id, [input(1)]);
    await store.updatePage(p.id, { ocrText: "Texte OCR", text: "Texte OCR", ocrStatus: "done" });
    store.setPageText(p.id, "Texte OCR corrigé");
    expect(store.getState().pages[p.id].edited).toBe(true);
    await store.flushPendingWrites();
    const { pages } = await db.loadAll();
    expect(pages.find((x) => x.id === p.id)).toMatchObject({ text: "Texte OCR corrigé", edited: true });
    store.setPageText(p.id, "Texte OCR");
    expect(store.getState().pages[p.id].edited).toBe(false);
  });

  it("reprise après interruption : une page « en cours » repasse « en attente »", async () => {
    const doc = await store.createDoc();
    const [p] = await store.addPages(doc.id, [input(1)]);
    await store.updatePage(p.id, { ocrStatus: "processing" });
    await store.initStore(); // simule un rechargement
    expect(store.getState().pages[p.id].ocrStatus).toBe("pending");
  });

  it("dupliquer et supprimer un document", async () => {
    const doc = await store.createDoc("Original");
    await store.addPages(doc.id, [input(1), input(2)]);
    store.setPageText(store.getDocPages(doc.id)[0].id, "page un");
    const copy = (await store.duplicateDoc(doc.id))!;
    expect(copy.name).toBe("Original (copie)");
    expect(docText(copy.id)).toEqual(["page un", ""]);
    const copyFirst = store.getDocPages(copy.id)[0];
    expect(await (await db.getBlob(copyFirst.id, "orig"))!.text()).toBe("img-1");
    await store.deleteDoc(doc.id);
    expect(store.getState().docs[doc.id]).toBeUndefined();
    expect(docText(copy.id)).toEqual(["page un", ""]);
  });
});
