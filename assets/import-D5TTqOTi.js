import{ap as f}from"./index-3wRPWDFQ.js";class u extends Error{constructor(){super("Ce PDF est protégé par un mot de passe : il ne peut pas être importé."),this.name="PdfPasswordError"}}async function m(){const t=await f(()=>import("./pdf-C9b_XmDn.js"),[],import.meta.url);if(!t.GlobalWorkerOptions.workerSrc){const o=await f(()=>import("./pdf.worker.min-B-BczD9f.js"),[],import.meta.url);t.GlobalWorkerOptions.workerSrc=o.default}return t}async function g(t){const o=await m(),i=new Uint8Array(await t.arrayBuffer());try{return await o.getDocument({data:i}).promise}catch(n){throw n instanceof Error&&n.name==="PasswordException"?new u:new Error("Ce fichier PDF est illisible ou endommagé.")}}async function p(t,o){const i=await t.getPage(o);try{const c=(await i.getTextContent()).items.filter(e=>"str"in e);let a="",s=null,r=0;for(const e of c){const l=e.transform[5],h=Math.abs(e.height)||Math.abs(e.transform[3])||10;s!==null&&a&&!a.endsWith(`
`)&&Math.abs(s-l)>Math.max(r,h)*.5&&(a+=`
`),s!==null&&a.endsWith(`
`)&&Math.abs(s-l)>Math.max(r,h)*1.8&&!a.endsWith(`

`)&&(a+=`
`),a+=e.str,e.hasEOL&&!a.endsWith(`
`)&&(a+=`
`),(e.str.trim()||e.hasEOL)&&(s=l,r=h)}return a.replace(/[ \t]+\n/g,`
`).replace(/\n{3,}/g,`

`).trim()}finally{i.cleanup()}}async function y(t){const o=Math.min(t.numPages,3);let i=0;for(let n=1;n<=o;n++)i+=(await p(t,n)).replace(/\s/g,"").length;return i>=30*o}async function P(t,o,i){const n=await t.getPage(o);try{const c=n.getViewport({scale:1}),a=Math.min(4,i/Math.max(c.width,c.height)),s=n.getViewport({scale:a}),r=document.createElement("canvas");r.width=Math.round(s.width),r.height=Math.round(s.height);const e=r.getContext("2d");return e.fillStyle="#fff",e.fillRect(0,0,r.width,r.height),await n.render({canvas:r,canvasContext:e,viewport:s}).promise,r}finally{n.cleanup()}}export{u as PdfPasswordError,p as extractPageText,g as openPdf,y as pdfHasText,P as renderPdfPage};
