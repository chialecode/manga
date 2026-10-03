// Official source refresh for the bounded PDF MVP recommendation; no dependency changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
const specs=[
  ['npm-latest','https://registry.npmjs.org/pdfjs-dist/latest'],
  ['github-release','https://api.github.com/repos/mozilla/pdf.js/releases/latest'],
  ['github-maintenance','https://api.github.com/repos/mozilla/pdf.js'],
  ['official-layers','https://mozilla.github.io/pdf.js/getting_started/'],
  ['official-display-example','https://mozilla.github.io/pdf.js/examples/'],
  ['official-api','https://mozilla.github.io/pdf.js/api/draft/api.js.html'],
  ['react-wrapper','https://raw.githubusercontent.com/wojtekmaj/react-pdf/main/packages/react-pdf/README.md'],
  ['mupdf-license','https://mupdf.readthedocs.io/en/latest/license.html'],
];
const sources=await Promise.all(specs.map(async([name,url])=>{
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(25000),headers:{'User-Agent':'MANGA-development-review'}}),body=await r.text();
    const item={name,url,status:r.status,sha256:createHash('sha256').update(body).digest('hex')};
    if(!r.ok)return item;
    if(name==='npm-latest'){const j=JSON.parse(body);item.summary={version:j.version,license:j.license,engines:j.engines,repository:j.repository};}
    else if(name==='github-release'){const j=JSON.parse(body);item.summary={tag:j.tag_name,published:j.published_at,prerelease:j.prerelease,draft:j.draft,url:j.html_url};}
    else if(name==='github-maintenance'){const j=JSON.parse(body);item.summary={archived:j.archived,disabled:j.disabled,pushedAt:j.pushed_at,defaultBranch:j.default_branch,license:j.license?.spdx_id};}
    else if(name==='official-layers')item.summary={core:body.includes('Core'),display:body.includes('Display'),viewer:body.includes('Viewer'),worker:body.includes('pdf.worker.mjs'),paraphrase:'Official layers separate binary parsing, rendering API and full viewer UI.'};
    else if(name==='official-display-example')item.summary={getDocument:body.includes('getDocument'),render:body.includes('render'),viewport:body.includes('getViewport'),paraphrase:'The official display example renders a page on canvas using viewport scale and device pixel ratio.'};
    else if(name==='official-api')item.summary={getTextContent:body.includes('getTextContent'),destroy:body.includes('destroy'),cancel:body.includes('cancel'),cMapUrl:body.includes('cMapUrl'),standardFontDataUrl:body.includes('standardFontDataUrl'),wasmUrl:body.includes('wasmUrl'),paraphrase:'Loading, page rendering, text extraction and cleanup are exposed separately; MANGA must bind their lifetimes to its own sessions.'};
    else if(name==='react-wrapper')item.summary={usesPdfjs:/pdf[.]?js/i.test(body),textLayer:body.includes('TextLayer'),paraphrase:'React-PDF wraps PDF.js with React Document/Page components; it does not replace MANGA source mapping and lifecycle responsibilities.'};
    else item.summary={agpl:body.includes('AGPL'),commercial:body.toLowerCase().includes('commercial'),paraphrase:'MuPDF offers AGPL and commercial licensing; adoption would add a separate distribution/license decision.'};
    return item;
  }catch(e){return{name,url,status:'request-failed',error:e.name};}
}));
const installed=JSON.parse(fs.readFileSync('node_modules/pdfjs-dist/package.json','utf8'));
const report={at:new Date().toISOString(),queryDate:'2026-09-25',status:'official-source-and-local-code-assessment',sources,installed:{version:installed.version,license:installed.license,engines:installed.engines},recommendation:'Use the already evaluated PDF.js Display API plus its TextLayer for the PDF MVP; retain MANGA resource/revision/source identity. Remove the custom PDF parsing/rendering production path after integration passes. Do not introduce an extra React viewer wrapper in this batch.',productionAdoption:'planned-not-yet-integrated',accepted:false,productAcceptance:'not-run'};
fs.writeFileSync(path.join(dir,'pdfjs-mvp-assessment.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
