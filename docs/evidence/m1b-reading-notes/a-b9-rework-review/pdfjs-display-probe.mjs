// Candidate Display API probe, separate from the frozen product review. No production adoption.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
const dir=path.dirname(fileURLToPath(import.meta.url)),observations=[];
const assetUrl=name=>path.resolve('node_modules/pdfjs-dist',name).replaceAll('\\','/')+'/';
for(const name of ['unequal-glyph-extents','courier-spacing-glyph-extents','courier-half-scale-control']){
  const task=getDocument({data:new Uint8Array(fs.readFileSync(path.join(dir,name+'.pdf'))),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,cMapUrl:assetUrl('cmaps'),cMapPacked:true,standardFontDataUrl:assetUrl('standard_fonts'),wasmUrl:assetUrl('wasm')});
  try{
    const doc=await task.promise,page=await doc.getPage(1),viewport=page.getViewport({scale:4}),canvas=createCanvas(viewport.width,viewport.height),ctx=canvas.getContext('2d');
    await page.render({canvasContext:ctx,viewport}).promise;
    fs.writeFileSync(path.join(dir,'pdfjs-'+name+'.png'),canvas.toBuffer('image/png'));
    // Equivalent operators occur 40 PDF units apart. Compare whole row rasters at the same subpixel phase.
    const a=ctx.getImageData(160,240,400,120).data,b=ctx.getImageData(160,400,400,120).data;
    let differentChannels=0,nonWhiteChannels=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i])differentChannels++;if(a[i]!==255)nonWhiteChannels++;}
    observations.push({name,status:differentChannels===0&&nonWhiteChannels>0?'passed':'failed',differentChannels,nonWhiteChannels,pageSize:{width:viewport.width,height:viewport.height},inputSha256:createHash('sha256').update(fs.readFileSync(path.join(dir,name+'.pdf'))).digest('hex')});
    page.cleanup();
  }catch(e){observations.push({name,status:'failed',error:e.message});}finally{await task.destroy();}
}
const report={at:new Date().toISOString(),kind:'candidate-display-api-probe',engine:'pdfjs-dist',version,accepted:false,productionIntegration:'not-run',productAcceptance:'not-run',scope:'Node Display API with local standard fonts and synthetic PDFs; raster equality of equivalent joined/split operators; not an Electron/text-selection/old-anchor validation',observations};
fs.writeFileSync(path.join(dir,'pdfjs-display-probe.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
