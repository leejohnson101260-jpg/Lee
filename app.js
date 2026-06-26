"use strict";
/* ============================================================
   Amostra de Cor Digital — PWA (index.html + style.css + app.js
   + lentes.json + jspdf.umd.min.js). Otimizado para iOS Safari.
   ============================================================ */

const $ = id => document.getElementById(id);
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

/* ---------- Lens color database ----------
   Loaded from lentes.json (Brazilian market: ZEISS, Ray-Ban,
   Oakley, Maui Jim, Costa, Essilor, Serengeti, Persol + generic
   ABNT/ISO filter-category families). VLT from manufacturer specs;
   RGB are estimated apparent colors. fam = first word of name,
   used to deduplicate suggestions. ---------- */
let DB = [];   // filled by loadDB() before any analysis can run

async function loadDB(){
  try{
    const res = await fetch("lentes.json", {cache:"no-store"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    DB = await res.json();
  }catch(e){
    DB = [];
    console.error("Falha ao carregar lentes.json:", e);
  }
}

/* ---------- State ---------- */
let img = null;
let off = null;                       // {w,h,f,data}: offscreen pixels, f = off px per image px
let view = {scale:1, ox:0, oy:0};
let outline = [];                     // lens outline, IMAGE coords
let traced = false;
let lensType = "solid";
let analysis = null;
let chosenMatch = null;   // a DB entry the user tapped to override the detected color

const cv = $("cv"), ctx = cv.getContext("2d", {willReadFrequently:true});
const wrap = $("cwrap");

/* ============================================================
   TRACE CORE — pure functions (testable outside the browser)
   Detection: a lens is the region notably MORE SATURATED or
   notably DARKER than the photo's border/background. The best
   connected blob (size × closeness to center) is wrapped in a
   convex hull, which ignores internal reflections, and the hull
   is resampled into 16 evenly spaced handle points.
   ============================================================ */
/* TRACE-CORE-BEGIN */
function bgStats(data,w,h){
  const sats=[],lums=[],ring=3;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(x>=ring&&x<w-ring&&y>=ring&&y<h-ring)continue;
    const i=(y*w+x)*4,r=data[i],g=data[i+1],b=data[i+2];
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    sats.push(mx?(mx-mn)/mx:0);
    lums.push(0.299*r+0.587*g+0.114*b);
  }
  const med=a=>{const s=[...a].sort((p,q)=>p-q);return s[s.length>>1];};
  return {bgSat:med(sats), bgLum:med(lums)};
}

function hueOf(r,g,b){
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
  if(mx===mn) return -1;
  const d=mx-mn;let hv;
  if(mx===r) hv=((g-b)/d)%6;
  else if(mx===g) hv=(b-r)/d+2;
  else hv=(r-g)/d+4;
  hv*=60; if(hv<0)hv+=360;
  return hv;
}
function hueDiff(a,b){const d=Math.abs(a-b)%360;return d>180?360-d:d;}

/* A lens is the TRANSLUCENT TINTED region of the photo:
   mid luminance (not the near-black frame, not white paper/highlights)
   with either real color (dominant hue cluster) or, failing that,
   a neutral region darker than the background (grey lenses). */
function lensMask(data,w,h,bgLum){
  const n=w*h;
  // pass 1: tinted candidates = saturated + mid luminance
  const lumA=new Float32Array(n), satA=new Float32Array(n), hueA=new Float32Array(n);
  for(let p=0,i=0;p<n;p++,i+=4){
    const r=data[i],g=data[i+1],b=data[i+2];
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    lumA[p]=0.299*r+0.587*g+0.114*b;
    satA[p]=mx?(mx-mn)/mx:0;
    hueA[p]=hueOf(r,g,b);
  }
  // dominant hue among tinted candidates (weighted by saturation)
  const bins=new Float32Array(18);
  let nCand=0;
  for(let p=0;p<n;p++){
    if(satA[p]>0.14 && lumA[p]>45 && lumA[p]<225){
      bins[Math.min(17,(hueA[p]/20)|0)]+=satA[p];
      nCand++;
    }
  }
  if(nCand > n*0.01){
    let bi=0;for(let k=1;k<18;k++)if(bins[k]>bins[bi])bi=k;
    const domHue=bi*20+10;
    const mask=new Uint8Array(n);
    for(let p=0;p<n;p++){
      if(satA[p]>0.10 && lumA[p]>45 && lumA[p]<225 &&
         hueA[p]>=0 && hueDiff(hueA[p],domHue)<=35) mask[p]=1;
    }
    return {mask,domHue,grey:false};
  }
  // grey-lens fallback: neutral region clearly darker than background
  const mask=new Uint8Array(n);
  for(let p=0;p<n;p++){
    if(satA[p]<0.20 && lumA[p]>40 && lumA[p]<bgLum-30) mask[p]=1;
  }
  return {mask,domHue:-1,grey:true};
}

function findComponents(mask,w,h){
  const label=new Int32Array(w*h);
  const comps=[];let id=0;
  const stack=[];
  for(let p0=0;p0<w*h;p0++){
    if(!mask[p0]||label[p0])continue;
    id++;let count=0,sumx=0,sumy=0;
    stack.length=0;stack.push(p0);label[p0]=id;
    while(stack.length){
      const p=stack.pop();const x=p%w,y=(p/w)|0;
      count++;sumx+=x;sumy+=y;
      if(x>0    &&mask[p-1]&&!label[p-1]){label[p-1]=id;stack.push(p-1);}
      if(x<w-1  &&mask[p+1]&&!label[p+1]){label[p+1]=id;stack.push(p+1);}
      if(y>0    &&mask[p-w]&&!label[p-w]){label[p-w]=id;stack.push(p-w);}
      if(y<h-1  &&mask[p+w]&&!label[p+w]){label[p+w]=id;stack.push(p+w);}
    }
    comps.push({id,count,cx:sumx/count,cy:sumy/count});
  }
  return {label,comps};
}

function blobBoundary(label,id,w,h){
  const pts=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const p=y*w+x; if(label[p]!==id)continue;
    if(x===0||y===0||x===w-1||y===h-1||
       label[p-1]!==id||label[p+1]!==id||label[p-w]!==id||label[p+w]!==id) pts.push({x,y});
  }
  return pts;
}

function convexHull(pts){
  pts=pts.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
  if(pts.length<3)return pts;
  const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lo=[],up=[];
  for(const p of pts){while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}
  for(let i=pts.length-1;i>=0;i--){const p=pts[i];
    while(up.length>=2&&cross(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}
  lo.pop();up.pop();
  return lo.concat(up);
}

function resampleClosed(poly,n){
  const seg=[];let total=0;
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length];
    const d=Math.hypot(b.x-a.x,b.y-a.y);seg.push(d);total+=d;
  }
  if(total===0) return poly.slice(0,n);
  const out=[];let acc=0,i=0;
  for(let k=0;k<n;k++){
    const target=k*total/n;
    while(acc+seg[i]<target){acc+=seg[i];i=(i+1)%poly.length;}
    const a=poly[i],b=poly[(i+1)%poly.length];
    const t=seg[i]?(target-acc)/seg[i]:0;
    out.push({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t});
  }
  return out;
}

/* Full trace: returns 16 outline points in the data's pixel coords, or null. */
function blobBounds(label,id,w,h){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(label[y*w+x]===id){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
  }
  return {x0,y0,x1,y1};
}

function traceLens(data,w,h){
  // The lens is photographed bare on a light sheet. The lens is the DARKEST
  // sizeable region near the center. Build a mask of dark pixels and pick the
  // darkest central blob — this ignores the white sheet and the dark desk
  // margins around it.
  const n=w*h;
  const lum=new Float32Array(n);
  for(let p=0,i=0;p<n;p++,i+=4){ lum[p]=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; }
  // brightness of the sheet = bright median (sample whole image)
  const sorted=Array.from(lum).sort((a,b)=>a-b);
  const sheetLum=sorted[Math.floor(n*0.75)];   // upper quartile ~ the light sheet
  // dark threshold: clearly darker than the sheet
  const thr=Math.min(sheetLum-45, 130);
  const mask=new Uint8Array(n);
  for(let p=0;p<n;p++){ if(lum[p] < thr) mask[p]=1; }

  const {label,comps}=findComponents(mask,w,h);
  const cxc=w/2,cyc=h/2,maxD=Math.hypot(cxc,cyc);
  // average luminance per component
  const sumLum={}, cnt={};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const p=y*w+x, id=label[p];
    if(id>0){ sumLum[id]=(sumLum[id]||0)+lum[p]; cnt[id]=(cnt[id]||0)+1; }
  }
  let best=null,bestScore=-1;
  for(const c of comps){
    if(c.count<n*0.01 || c.count>n*0.80)continue;            // ignore specks and full-frame
    const d=Math.hypot(c.cx-cxc,c.cy-cyc)/maxD;              // 0 center .. 1 corner
    if(d>0.55)continue;                                      // lens is near center; reject edge strips
    // reject thin strips (desk margins): bounding box must be reasonably filled
    const bb=blobBounds(label,c.id,w,h);
    const bw=bb.x1-bb.x0+1, bh=bb.y1-bb.y0+1;
    const fill=c.count/(bw*bh);
    const aspect=Math.max(bw,bh)/Math.max(1,Math.min(bw,bh));
    if(fill<0.45 || aspect>3.2)continue;                     // lens is blob-like, not a strip
    const avg=sumLum[c.id]/cnt[c.id];                        // darker = better
    const darkScore=(255-avg)/255;
    const sizeScore=Math.min(1, c.count/(n*0.25));
    const score=darkScore*0.7 + sizeScore*0.2 + (1-d)*0.1;
    if(score>bestScore){bestScore=score;best=c;}
  }
  if(!best)return null;
  const hull=convexHull(blobBoundary(label,best.id,w,h));
  if(hull.length<3)return null;
  return resampleClosed(hull,16);
}

function inPoly(x,y,pts){
  let c=false;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    if(((pts[i].y>y)!==(pts[j].y>y)) &&
       (x < (pts[j].x-pts[i].x)*(y-pts[i].y)/(pts[j].y-pts[i].y)+pts[i].x)) c=!c;
  }
  return c;
}

/* Sample 10 horizontal bands inside the outline polygon.
   Pixels that are frame-dark (<45 lum) or highlight-bright (>235 lum) are
   excluded, and if the lens has real color, only pixels near the dominant
   hue are kept. If a band ends up with too few filtered pixels (e.g. very
   dark lenses), it falls back to unfiltered sampling for that band. */
function samplePolyBands(data,w,h,f,outline){
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  for(const p of outline){
    minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);
  }
  minX=Math.max(0,minX);minY=Math.max(0,minY);
  maxX=Math.min(w/f,maxX);maxY=Math.min(h/f,maxY);
  if(maxX-minX<4||maxY-minY<4) return new Array(10).fill(null);
  const ox0=Math.max(0,Math.floor(minX*f)), ox1=Math.min(w,Math.ceil(maxX*f));
  const stepX=Math.max(1,Math.floor((ox1-ox0)/120));

  // pass 1: dominant hue of the tinted pixels inside the polygon
  const bins=new Float32Array(18);let nTint=0,nAll=0;
  {
    const oyA=Math.max(0,Math.floor(minY*f)), oyB=Math.min(h,Math.ceil(maxY*f));
    const stepY=Math.max(1,Math.floor((oyB-oyA)/60));
    for(let oy=oyA;oy<oyB;oy+=stepY){
      const yi=oy/f;
      for(let ox=ox0;ox<ox1;ox+=stepX){
        if(!inPoly(ox/f,yi,outline)) continue;
        const idx=(oy*w+ox)*4;
        const r=data[idx],g=data[idx+1],b=data[idx+2];
        const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
        const sat=mx?(mx-mn)/mx:0, lum=0.299*r+0.587*g+0.114*b;
        nAll++;
        if(sat>0.12 && lum>45 && lum<235){
          const hv=hueOf(r,g,b);
          if(hv>=0){ bins[Math.min(17,(hv/20)|0)]+=sat; nTint++; }
        }
      }
    }
  }
  let domHue=-1;
  if(nAll && nTint>nAll*0.15){
    let bi=0;for(let k=1;k<18;k++)if(bins[k]>bins[bi])bi=k;
    domHue=bi*20+10;
  }

  // pass 2: band medians over filtered pixels
  const bands=[];
  for(let i=0;i<10;i++){
    const oy0=Math.max(0,Math.floor((minY+(i/10)*(maxY-minY))*f));
    const oy1=Math.min(h,Math.ceil((minY+((i+1)/10)*(maxY-minY))*f));
    const stepY=Math.max(1,Math.floor((oy1-oy0)/14));
    const collect=(filtered)=>{
      const rs=[],gs=[],bs=[],lumL=[];
      for(let oy=oy0;oy<oy1;oy+=stepY){
        const yi=oy/f;
        for(let ox=ox0;ox<ox1;ox+=stepX){
          if(!inPoly(ox/f,yi,outline)) continue;
          const idx=(oy*w+ox)*4;
          const r=data[idx],g=data[idx+1],b=data[idx+2];
          const lum=0.299*r+0.587*g+0.114*b;
          if(filtered){
            if(lum<45||lum>235) continue;
            if(domHue>=0){
              const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
              const sat=mx?(mx-mn)/mx:0;
              if(sat>0.10){
                const hv=hueOf(r,g,b);
                if(hv>=0 && hueDiff(hv,domHue)>35) continue;
              }
            }
          }
          rs.push(r);gs.push(g);bs.push(b);lumL.push(lum);
        }
      }
      return {rs,gs,bs,lumL};
    };
    let s=collect(true);
    if(s.rs.length<10) s=collect(false);   // dark-lens fallback
    if(s.rs.length<10){ bands.push(null); continue; }
    const idx=[...s.lumL.keys()].sort((a,b)=>s.lumL[a]-s.lumL[b]);
    const keep=idx.slice(Math.floor(idx.length*0.10),Math.ceil(idx.length*0.90));
    const med=arr=>{const t=keep.map(k=>arr[k]).sort((a,b)=>a-b);return t[Math.floor(t.length/2)];};
    bands.push([Math.round(med(s.rs)),Math.round(med(s.gs)),Math.round(med(s.bs))]);
  }
  return bands;
}
/* ---- Lab color space: perceptual color difference (ΔE), the same
        kind of measure used in optics/colorimetry. RGB distance treats
        rose and light brown as neighbours; Lab does not. ---- */
function rgbToLab(c){
  const lin=v=>{v/=255;return v>0.04045?Math.pow((v+0.055)/1.055,2.4):v/12.92;};
  const r=lin(c[0]),g=lin(c[1]),b=lin(c[2]);
  let X=(r*0.4124+g*0.3576+b*0.1805)/0.95047;
  let Y= r*0.2126+g*0.7152+b*0.0722;
  let Z=(r*0.0193+g*0.1192+b*0.9505)/1.08883;
  const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
  const fx=f(X),fy=f(Y),fz=f(Z);
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}
function deltaE(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);}

/* ---- Linear light: camera pixel values are gamma-encoded; all
        transmission math must happen in linear luminance. ---- */
function linLum(r,g,b){
  const lin=v=>{v/=255;return v>0.04045?Math.pow((v+0.055)/1.055,2.4):v/12.92;};
  return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
}

/* ---- Background luminance profile around the lens (LINEAR).
        The surface behind a translucent lens often varies from top to
        bottom (desk above, paper below…). To avoid reading that as a
        tint gradient, we estimate the background PER HORIZONTAL BAND
        from the ring beside the lens at that height, and normalize
        each band's transmission by its own local background. ---- */
function bgLumProfile(data,w,h,f,outline){
  let cx=0,cy=0,minY=1e9,maxY=-1e9;
  for(const p of outline){cx+=p.x;cy+=p.y;minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
  cx/=outline.length;cy/=outline.length;
  const outer=outline.map(p=>({x:cx+(p.x-cx)*1.8, y:cy+(p.y-cy)*1.8}));
  let oMinX=1e9,oMaxX=-1e9,oMinY=1e9,oMaxY=-1e9;
  for(const p of outer){
    oMinX=Math.min(oMinX,p.x);oMaxX=Math.max(oMaxX,p.x);
    oMinY=Math.min(oMinY,p.y);oMaxY=Math.max(oMaxY,p.y);
  }
  const all=[], per=Array.from({length:10},()=>[]);
  const ox0=Math.max(0,Math.floor(oMinX*f)),ox1=Math.min(w,Math.ceil(oMaxX*f));
  const oy0=Math.max(0,Math.floor(oMinY*f)),oy1=Math.min(h,Math.ceil(oMaxY*f));
  const stepX=Math.max(1,Math.floor((ox1-ox0)/110)), stepY=Math.max(1,Math.floor((oy1-oy0)/110));
  const span=Math.max(1e-6,maxY-minY);
  for(let oy=oy0;oy<oy1;oy+=stepY){
    const yi=oy/f;
    for(let ox=ox0;ox<ox1;ox+=stepX){
      const xi=ox/f;
      if(inPoly(xi,yi,outline))continue;       // not the lens itself
      if(!inPoly(xi,yi,outer))continue;        // only the nearby ring
      const idx=(oy*w+ox)*4;
      const lum=linLum(data[idx],data[idx+1],data[idx+2]);
      if(lum<=0.045 || lum>=0.96)continue;     // skip frame (dark) and blown highlights
      all.push(lum);
      let b=Math.floor((yi-minY)/span*10);
      b=Math.max(0,Math.min(9,b));             // ring above/below maps to first/last band
      per[b].push(lum);
    }
  }
  const med=a=>{if(a.length<6)return null;const s=a.slice().sort((p,q)=>p-q);return s[s.length>>1];};
  return {global: all.length>=10?med(all):null, perBand: per.map(med)};
}

/* Backwards-compatible single value (median of the whole ring). */
function bgLumAround(data,w,h,f,outline){
  return bgLumProfile(data,w,h,f,outline).global;
}
/* TRACE-CORE-END */

/* ============================================================
   STEP 1 — capture
   ============================================================ */
$("drop").addEventListener("click", ()=> $("file").click());
$("file").addEventListener("change", e=>{
  const status=$("capStatus");
  status.textContent="";
  const f = e.target.files && e.target.files[0];
  if(!f){ status.textContent="Nenhum arquivo selecionado."; return; }
  status.textContent="Carregando imagem…";
  const reader=new FileReader();
  reader.onerror=()=>{ status.textContent="Erro ao ler o arquivo. Tente outra foto."; };
  reader.onload=()=>{
    const im=new Image();
    im.onload=()=>{
      if(!im.width||!im.height){ status.textContent="Imagem inválida (0 px). Tente outra foto."; return; }
      img=im; status.textContent=""; enterIsolate();
    };
    im.onerror=()=>{ status.textContent="Não foi possível abrir a imagem. Use JPG ou PNG (HEIC pode falhar)."; };
    im.src=reader.result;
  };
  reader.readAsDataURL(f);
});

/* ============================================================
   STEP 2 — trace & adjust
   ============================================================ */
function enterIsolate(){
  $("step-capture").classList.add("hidden");
  $("step-results").classList.add("hidden");
  $("step-isolate").classList.remove("hidden");
  $("traceNote").textContent="Detectando lente…";
  requestAnimationFrame(()=>requestAnimationFrame(()=>setupCanvasAndImage(0)));
}

function setupCanvasAndImage(attempt){
  layoutCanvas();
  if(cv.width<10 && attempt<10){
    requestAnimationFrame(()=>setupCanvasAndImage(attempt+1));
    return;
  }
  const cw = cv.width, ch = cv.height;
  const s = Math.min(cw/img.width, ch/img.height);
  view.scale = s;
  view.ox = (cw - img.width*s)/2;
  view.oy = (ch - img.height*s)/2;
  buildOffscreen();
  autoTrace();
  draw();
}

function layoutCanvas(){
  let cssW = wrap.clientWidth;
  if(!cssW){ cssW = Math.min(window.innerWidth - 64, 700); }
  const cssH = Math.round(cssW * 0.78);
  cv.style.height = cssH + "px";
  cv.width = Math.round(cssW);
  cv.height = Math.round(cssH);
}

function buildOffscreen(){
  const maxW=1000;
  const f=Math.min(1, maxW/Math.max(img.width,img.height));
  const w=Math.max(1,Math.round(img.width*f)), h=Math.max(1,Math.round(img.height*f));
  const oc=document.createElement("canvas");oc.width=w;oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.drawImage(img,0,0,w,h);
  off={w,h,f,data:octx.getImageData(0,0,w,h).data};
}

function autoTrace(){
  // Lens is photographed bare on a white surface. Auto-detect the lens blob
  // (dark/tinted area against white). If detection fails, fall back to a
  // centered oval the user drags. Either way, the user can adjust the dots.
  const tw=Math.min(off.w,320), tf=tw/off.w, th=Math.max(1,Math.round(off.h*tf));
  const tdata=new Uint8ClampedArray(tw*th*4);
  for(let y=0;y<th;y++){
    const sy=Math.min(off.h-1,Math.round(y/tf));
    for(let x=0;x<tw;x++){
      const sx=Math.min(off.w-1,Math.round(x/tf));
      const si=(sy*off.w+sx)*4, di=(y*tw+x)*4;
      tdata[di]=off.data[si];tdata[di+1]=off.data[si+1];tdata[di+2]=off.data[si+2];tdata[di+3]=255;
    }
  }
  const pts=traceLens(tdata,tw,th);
  traced=!!pts;
  let p16;
  if(pts){
    p16=pts;
  }else{
    p16=[];const cx=tw/2,cy=th/2,rx=tw*0.30,ry=th*0.30;
    for(let k=0;k<16;k++){const a=k/16*2*Math.PI;p16.push({x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry});}
  }
  const g=1/(tf*off.f);   // trace px -> image px
  outline=p16.map(p=>({x:p.x*g,y:p.y*g}));
  $("traceNote").textContent = traced
    ? "Lente detectada. Arraste os pontos verdes para ajustar a borda. Arraste dentro para mover tudo. Dois dedos: zoom."
    : "Não detectei a lente. Arraste os pontos verdes manualmente sobre a borda da lente.";
}

/* ---------- canvas drawing ---------- */
function imageToView(px,py){ return {x:view.ox+px*view.scale, y:view.oy+py*view.scale}; }
function viewToImage(cx2,cy2){ return {x:(cx2-view.ox)/view.scale, y:(cy2-view.oy)/view.scale}; }

function pathOutline(cpts){
  const n=cpts.length;
  ctx.moveTo((cpts[0].x+cpts[n-1].x)/2,(cpts[0].y+cpts[n-1].y)/2);
  for(let i=0;i<n;i++){
    const a=cpts[i], b=cpts[(i+1)%n];
    ctx.quadraticCurveTo(a.x,a.y,(a.x+b.x)/2,(a.y+b.y)/2);
  }
  ctx.closePath();
}

function draw(){
  const cw=cv.width, ch=cv.height;
  ctx.save();
  ctx.fillStyle="#111"; ctx.fillRect(0,0,cw,ch);
  ctx.drawImage(img, view.ox, view.oy, img.width*view.scale, img.height*view.scale);
  const cpts=outline.map(p=>imageToView(p.x,p.y));
  ctx.save();
  ctx.beginPath(); ctx.rect(0,0,cw,ch);
  pathOutline(cpts);
  ctx.fillStyle="rgba(0,0,0,0.55)"; ctx.fill("evenodd");
  ctx.restore();
  ctx.beginPath();
  pathOutline(cpts);
  ctx.lineWidth=2.5; ctx.strokeStyle="#9ec24a"; ctx.stroke();
  for(const p of cpts){
    ctx.beginPath(); ctx.arc(p.x,p.y,8,0,Math.PI*2);
    ctx.fillStyle="#9ec24a"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle="#fff"; ctx.stroke();
  }
  ctx.restore();
}

/* ---------- touch: all listeners on the WRAPPER, never the canvas ---------- */
let mode=null;
let last=null;
let startDist=0, startScale=0;

function relPos(t){
  const r = cv.getBoundingClientRect();
  return {x:(t.clientX-r.left)*(cv.width/r.width), y:(t.clientY-r.top)*(cv.height/r.height)};
}
function dist(a,b){return Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);}
function mid(a,b){return {clientX:(a.clientX+b.clientX)/2, clientY:(a.clientY+b.clientY)/2};}

function hitTest(p){
  const cpts=outline.map(q=>imageToView(q.x,q.y));
  for(let i=0;i<cpts.length;i++){
    if(Math.hypot(p.x-cpts[i].x,p.y-cpts[i].y)<=22) return {type:"handle",i};
  }
  const ip=viewToImage(p.x,p.y);
  if(inPoly(ip.x,ip.y,outline)) return {type:"move"};
  return {type:"pan"};
}

wrap.addEventListener("touchstart", e=>{
  e.preventDefault();
  if(e.touches.length===1){
    const p=relPos(e.touches[0]);
    mode=hitTest(p); last=p;
  } else if(e.touches.length===2){
    mode={type:"pinch"};
    startDist=dist(e.touches[0],e.touches[1]);
    startScale=view.scale;
    last=relPos(mid(e.touches[0],e.touches[1]));
  }
},{passive:false});

wrap.addEventListener("touchmove", e=>{
  e.preventDefault();
  if(!mode) return;
  if(mode.type==="handle" && e.touches.length===1){
    const p=relPos(e.touches[0]);
    const ip=viewToImage(p.x,p.y);
    outline[mode.i]={x:ip.x,y:ip.y};
    last=p; draw();
  } else if(mode.type==="move" && e.touches.length===1){
    const p=relPos(e.touches[0]);
    const dx=(p.x-last.x)/view.scale, dy=(p.y-last.y)/view.scale;
    outline=outline.map(q=>({x:q.x+dx,y:q.y+dy}));
    last=p; draw();
  } else if(mode.type==="pan" && e.touches.length===1){
    const p=relPos(e.touches[0]);
    view.ox+=p.x-last.x; view.oy+=p.y-last.y; last=p; draw();
  } else if(mode.type==="pinch" && e.touches.length===2){
    const d=dist(e.touches[0],e.touches[1]);
    const ns=clamp(startScale*(d/startDist),0.1,8);
    const c=relPos(mid(e.touches[0],e.touches[1]));
    const k=ns/view.scale;
    view.ox=c.x-(c.x-view.ox)*k;
    view.oy=c.y-(c.y-view.oy)*k;
    view.scale=ns; draw();
  }
},{passive:false});

wrap.addEventListener("touchend", e=>{
  e.preventDefault();
  if(e.touches.length===0){ mode=null; }
  else if(e.touches.length===1){ mode={type:"pan"}; last=relPos(e.touches[0]); }
},{passive:false});

/* Mouse fallback (desktop testing) */
let mouseDown=false;
wrap.addEventListener("mousedown",e=>{
  const r=cv.getBoundingClientRect();
  const p={x:(e.clientX-r.left)*(cv.width/r.width),y:(e.clientY-r.top)*(cv.height/r.height)};
  mode=hitTest(p); last=p; mouseDown=true;
});
window.addEventListener("mousemove",e=>{
  if(!mouseDown||!mode) return;
  const r=cv.getBoundingClientRect();
  const p={x:(e.clientX-r.left)*(cv.width/r.width),y:(e.clientY-r.top)*(cv.height/r.height)};
  if(mode.type==="handle"){
    const ip=viewToImage(p.x,p.y); outline[mode.i]={x:ip.x,y:ip.y};
  } else if(mode.type==="move"){
    const dx=(p.x-last.x)/view.scale, dy=(p.y-last.y)/view.scale;
    outline=outline.map(q=>({x:q.x+dx,y:q.y+dy}));
  } else { view.ox+=p.x-last.x; view.oy+=p.y-last.y; }
  last=p; draw();
});
window.addEventListener("mouseup",()=>{mouseDown=false;mode=null;});

function scaleOutline(k){
  let cx=0,cy=0; outline.forEach(p=>{cx+=p.x;cy+=p.y;});
  cx/=outline.length; cy/=outline.length;
  outline=outline.map(p=>({x:cx+(p.x-cx)*k, y:cy+(p.y-cy)*k}));
  draw();
}
$("btnSmaller").addEventListener("click",()=>scaleOutline(0.92));
$("btnBigger").addEventListener("click",()=>scaleOutline(1.08));
$("btnRetrace").addEventListener("click",()=>{ autoTrace(); draw(); });

window.addEventListener("resize",()=>{ if(!$("step-isolate").classList.contains("hidden")){ layoutCanvas(); draw(); }});

/* ============================================================
   STEP 3 — analyze (lens type decided automatically)
   ============================================================ */
$("btnAnalyze").addEventListener("click", analyze);

function vltFromRgb(rgb,bgLin){
  // Linear-light ratio of lens to the surface behind it. A lens lying on
  // a surface dims the light more than once (down through the tint, off
  // the surface, back up), so apparent ratio ≈ T^1.5 in mixed lighting.
  // T = ratio^(2/3). Calibratable against lenses of known VLT.
  const base = bgLin || 1;
  const ratio = Math.min(1, linLum(rgb[0],rgb[1],rgb[2]) / base);
  return clamp(Math.round(Math.pow(ratio, 2/3)*100), 2, 95);
}
function categoryOf(vlt){       // EU/ABNT sunglass filter categories
  if(vlt>80)return 0; if(vlt>43)return 1; if(vlt>18)return 2;
  if(vlt>8)return 3; return 4;
}
function rgbToHex(c){return "#"+c.map(v=>v.toString(16).padStart(2,"0")).join("").toUpperCase();}
function rgbToCmyk(c){
  let r=c[0]/255,g=c[1]/255,b=c[2]/255;
  const k=1-Math.max(r,g,b);
  if(k>=1) return [0,0,0,100];
  const C=(1-r-k)/(1-k),M=(1-g-k)/(1-k),Y=(1-b-k)/(1-k);
  return [C,M,Y,k].map(v=>Math.round(v*100));
}

function analyze(){
  const bands=samplePolyBands(off.data,off.w,off.h,off.f,outline);
  const valid=bands.filter(Boolean);
  if(valid.length<6){
    alert("Não foi possível ler a lente. Ajuste o contorno sobre a área colorida e tente novamente.");
    return;
  }
  for(let i=0;i<10;i++) if(!bands[i]){ bands[i]=valid[Math.min(i,valid.length-1)]; }

  // local background per band — a varying surface behind a translucent
  // lens must NOT be read as a tint gradient
  const prof = bgLumProfile(off.data,off.w,off.h,off.f,outline);
  const bgOf = i => prof.perBand[i] || prof.global;

  // background-normalized transmission per band (true tint profile)
  const vlts = bands.map((b,i)=>vltFromRgb(b,bgOf(i)));

  // A true gradient: normalized VLT climbs SMOOTHLY and MONOTONICALLY
  // top→bottom by >= 30 points. Reflections or background changes cause
  // reversals or are cancelled by the per-band normalization.
  let inversions=0;
  for(let i=0;i<9;i++){ if(vlts[i+1] < vlts[i]-4) inversions++; }
  const isGradient = (vlts[9]-vlts[0]) >= 30 && inversions<=1;

  const solid=[0,1,2].map(ch=>{
    const s=bands.map(b=>b[ch]).sort((a,b)=>a-b); return s[5];
  });
  const solidVlt = vlts.slice().sort((a,b)=>a-b)[5];   // median of band VLTs

  analysis={
    bands: bands.map((b,i)=>({rgb:b, vlt:vlts[i]})),
    solid:{rgb:solid, vlt:solidVlt},
    bgLum:prof.global,
    type: isGradient?"gradient":"solid"
  };
  lensType=analysis.type;
  showResults();
}

/* ============================================================
   Results UI — type is detected, never chosen
   ============================================================ */
function showResults(){
  $("step-isolate").classList.add("hidden");
  $("step-results").classList.remove("hidden");

  const isGrad = lensType==="gradient";
  const diff=analysis.bands[9].vlt-analysis.bands[0].vlt;
  $("typeLabel").textContent = isGrad
    ? `DEGRADÊ detectado — Δ ${diff} pontos de VLT (topo escuro → base clara)`
    : "LENTE SÓLIDA detectada";
  $("solidBox").classList.toggle("hidden", isGrad);
  $("gradBox").classList.toggle("hidden", !isGrad);
  $("transWrap").classList.toggle("hidden", !isGrad);

  const s=analysis.solid;
  $("solidSwatch").style.background=rgbToHex(s.rgb);
  $("sHex").textContent=rgbToHex(s.rgb);
  $("sRgb").textContent=s.rgb.join(", ");
  $("sCmyk").textContent=rgbToCmyk(s.rgb).join(" ");
  $("sVlt").textContent=s.vlt+"%";
  $("sFil").textContent=(100-s.vlt)+"%";
  $("sCat").textContent="Cat "+categoryOf(s.vlt);

  const wrapB=$("bands"); wrapB.innerHTML="";
  analysis.bands.forEach((b,i)=>{
    const row=document.createElement("div"); row.className="band";
    row.innerHTML=`<span class="lbl">${i+1}/10</span>
      <span class="chip" style="background:${rgbToHex(b.rgb)}"></span>
      <span>${rgbToHex(b.rgb)} · VLT ${b.vlt}%</span>`;
    wrapB.appendChild(row);
  });
  $("gTop").textContent=analysis.bands[0].vlt+"% (F "+(100-analysis.bands[0].vlt)+"%)";
  $("gBot").textContent=analysis.bands[9].vlt+"% (F "+(100-analysis.bands[9].vlt)+"%)";

  let lastSao=null;
  try{ lastSao=localStorage.getItem("lens_last_sao"); }catch(e){}
  if(lastSao) $("sao").value=lastSao;
  $("os").value="";
  validateSave();
  refreshMatches();
  applyChosenColor();   // reset swatch/note to measured state
  validateSave();
}

/* ---------- apply / clear a user-selected match over the detected color ----------
   For SOLID lenses, picking a similar lens replaces the displayed swatch and
   stats. The chosen color is also what goes into the PDF. */
function effectiveSolid(){
  // returns {rgb, vlt} to use everywhere (chosen if any, else measured)
  if(chosenMatch){
    const v = Math.round((chosenMatch.vlt[0]+chosenMatch.vlt[1])/2);
    return { rgb: chosenMatch.rgb.slice(), vlt: v, name: chosenMatch.name, farb: chosenMatch.farb||null, grad: chosenMatch.grad||null };
  }
  return { rgb: analysis.solid.rgb, vlt: analysis.solid.vlt, name: null, farb: null, grad: null };
}
function applyChosenColor(){
  if(lensType!=="solid"){ // for gradient we only note the choice, swatch stays
    const note=$("colorSource");
    if(note) note.textContent = chosenMatch
      ? ("Cor escolhida: "+chosenMatch.name+(chosenMatch.farb?(" — FARB "+chosenMatch.farb):""))
      : "Cor medida da lente.";
    return;
  }
  const e=effectiveSolid();
  $("solidSwatch").style.background=rgbToHex(e.rgb);
  $("sHex").textContent=rgbToHex(e.rgb);
  $("sRgb").textContent=e.rgb.join(", ");
  $("sCmyk").textContent=rgbToCmyk(e.rgb).join(" ");
  $("sVlt").textContent=e.vlt+"%";
  $("sFil").textContent=(100-e.vlt)+"%";
  $("sCat").textContent="Cat "+categoryOf(e.vlt);
  const note=$("colorSource");
  if(note) note.textContent = chosenMatch
    ? ("Cor escolhida: "+chosenMatch.name+(chosenMatch.farb?(" — FARB "+chosenMatch.farb):"")+" (substitui a medida)")
    : "Cor medida da lente.";
}

/* ---------- color matching (last step before save) ----------
   Perceptual ΔE in Lab space + hue gate: a brown can never match a
   rose, no matter the numeric distance. VLT must also be close. */
function refreshMatches(){
  chosenMatch=null;
  const target = lensType==="gradient" ? analysis.bands[4].rgb : analysis.solid.rgb;
  const tVlt   = lensType==="gradient" ? analysis.bands[4].vlt : analysis.solid.vlt;
  const tLab=rgbToLab(target);
  const tHue=hueOf(target[0],target[1],target[2]);
  const tSat=(()=>{const mx=Math.max(...target),mn=Math.min(...target);return mx?(mx-mn)/mx:0;})();
  const scored=DB.map(d=>{
    const de=deltaE(tLab,rgbToLab(d.rgb));
    const dvlt=(d.vlt[0]+d.vlt[1])/2;
    const vd=Math.abs(tVlt-dvlt);
    // hue gate: if both colors are clearly colored, hues must agree
    const dHue=hueOf(d.rgb[0],d.rgb[1],d.rgb[2]);
    const dSat=(()=>{const mx=Math.max(...d.rgb),mn=Math.min(...d.rgb);return mx?(mx-mn)/mx:0;})();
    const hueBlocked = (tSat>0.18 && dSat>0.18 && tHue>=0 && dHue>=0 && hueDiff(tHue,dHue)>40);
    return {...d, de, vd, hueBlocked, score: de + vd*0.5};
  }).filter(d=>!d.hueBlocked && d.de<20 && d.vd<30)
    .sort((a,b)=>a.score-b.score);
  const seen=new Set(), out=[];
  for(const m of scored){
    const fam=m.name.split(" ")[0];
    if(seen.has(fam)) continue;
    seen.add(fam); out.push(m);
    if(out.length===3) break;
  }
  const list=$("matchList"); list.innerHTML="";
  if(out.length===0){
    $("matchNote").textContent="Nenhuma cor próxima no banco de dados. O relatório será salvo apenas com a medição.";
  }else{
    $("matchNote").textContent="Cores semelhantes encontradas (não é obrigatório escolher).";
    out.forEach(m=>{
      const el=document.createElement("div"); el.className="match";
      const nmeDisplay = m.farb ? `${m.name} — FARB ${m.farb}` : m.name;
      const gradLine = m.grad
        ? `<div class="ds">Degradê (ref.): escuro VLT ${m.grad.darkVlt}% → claro VLT ${m.grad.lightVlt}%</div>`
        : "";
      el.innerHTML=`<span class="chip" style="background:${rgbToHex(m.rgb)}"></span>
        <span><div class="nm">${nmeDisplay}</div>
        <div class="ds">VLT ${m.vlt[0]}–${m.vlt[1]}% · ΔE ${Math.round(m.de)}</div>${gradLine}</span>
        <span class="pick">tocar p/ usar</span>`;
      el.addEventListener("click",()=>{
        const already = el.classList.contains("sel");
        // clear any previous selection
        list.querySelectorAll(".match").forEach(x=>{
          x.classList.remove("sel");
          const p=x.querySelector(".pick"); if(p) p.textContent="tocar p/ usar";
        });
        if(already){
          chosenMatch=null;   // tapping the selected one again deselects
        }else{
          chosenMatch=m;
          el.classList.add("sel");
          const p=el.querySelector(".pick"); if(p) p.textContent="✓ selecionada";
        }
        applyChosenColor();
      });
      list.appendChild(el);
    });
  }
}

/* ---------- save ---------- */
$("sao").addEventListener("input",validateSave);
$("os").addEventListener("input",validateSave);
$("aco").addEventListener("input",validateSave);
$("transMm").addEventListener("input",validateSave);
function validateSave(){
  const hasSao=!!$("sao").value.trim(), hasOs=!!$("os").value.trim();
  const hasAco=!!$("aco").value.trim();
  const isGrad = analysis && analysis.type==="gradient";
  const hasTrans = !isGrad || !!$("transMm").value.trim();
  const ok=hasSao && hasOs && hasAco && hasTrans;
  $("btnSave").disabled=!ok;
  // Tell the user why the button is greyed out, so it never feels "broken".
  const msg=$("saveMsg");
  if(ok){
    if(msg.textContent.startsWith("Preencha")) msg.textContent="";
  }else{
    if(!hasSao)        msg.textContent="Preencha o número de SAO para liberar o botão.";
    else if(!hasOs)    msg.textContent="Preencha o número de OS para liberar o botão.";
    else if(!hasAco)   msg.textContent="Preencha a Altura de Centro Óptico (ACO) para liberar o botão.";
    else if(!hasTrans) msg.textContent="Preencha o tamanho da transição do degradê (mm) para liberar o botão.";
  }
}

function pad(n){return String(n).padStart(2,"0");}
function stamp(){
  const d=new Date();
  return {date:`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`,
          time:`${pad(d.getHours())}${pad(d.getMinutes())}`};
}

$("btnSave").addEventListener("click", ()=>{
  // Immediate visible confirmation that the tap registered (helps diagnose iOS).
  $("saveMsg").textContent="Gerando PDF…";
  if(!window.jspdf){ $("saveMsg").textContent="A biblioteca de PDF não carregou. Recarregue o aplicativo e tente novamente."; return; }
  // Defer the heavy work so the "Gerando PDF…" text paints first.
  setTimeout(runSave, 30);
});

function runSave(){
  try{
  { const v=document.getElementById("pdfView"); if(v){ v.classList.add("hidden"); v.innerHTML=""; } }
  const sao=$("sao").value.trim(), os=$("os").value.trim();
  const aco=$("aco").value.trim();
  const transMm = (analysis && analysis.type==="gradient") ? $("transMm").value.trim() : "";
  try{ localStorage.setItem("lens_last_sao", sao); }catch(e){}
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:"pt",format:"a4"});
  const W=595; let y=56;
  doc.setFont("times","italic"); doc.setTextColor(122,154,58); doc.setFontSize(26);
  doc.text("Amostra de Cor Digital",40,y);
  doc.setFont("courier","normal"); doc.setTextColor(120,120,120); doc.setFontSize(9);
  doc.text("COLOR · GRADIENT · TRANSPARENCY",40,y+16);
  doc.setDrawColor(31,42,20); doc.setLineWidth(1.5); doc.line(40,y+26,W-40,y+26);
  y+=54;
  doc.setTextColor(31,42,20); doc.setFont("courier","bold"); doc.setFontSize(11);
  doc.text(`SAO: ${sao}    OS: ${os}`,40,y);
  y+=16; doc.text(`ACO (altura centro optico): ${aco} mm`,40,y);
  if(transMm){ y+=16; doc.text(`Transicao do degrade: ${transMm} mm`,40,y); }
  const st=stamp();
  doc.setFont("courier","normal");
  doc.text(`Data: ${st.date}  Hora: ${st.time}`,40,y+16);
  doc.text(`Tipo (detecção automática): ${lensType==="gradient"?"Degradê":"Sólida"}`,40,y+32);
  y+=58;

  if(lensType==="solid"){
    const s=effectiveSolid();
    doc.setFillColor(s.rgb[0],s.rgb[1],s.rgb[2]); doc.rect(40,y,120,60,"F");
    doc.setFont("courier","normal"); doc.setFontSize(10); doc.setTextColor(31,42,20);
    doc.text(`HEX: ${rgbToHex(s.rgb)}`,180,y+14);
    doc.text(`RGB: ${s.rgb.join(", ")}`,180,y+30);
    doc.text(`CMYK: ${rgbToCmyk(s.rgb).join(" ")}`,180,y+46);
    doc.text(`VLT: ${s.vlt}%   Filtro: ${100-s.vlt}%   Categoria ${categoryOf(s.vlt)}`,180,y+62);
    y+=78;
    if(s.name){ doc.setFontSize(9); doc.setTextColor(95,122,44);
      doc.text(`Cor selecionada do banco: ${s.name}${s.farb?(" — FARB "+s.farb):""}`,180,y); y+=14;
      if(s.grad){ doc.text(`Degrade (ref. banco): escuro VLT ${s.grad.darkVlt}% -> claro VLT ${s.grad.lightVlt}%`,180,y); y+=14; } }
    else { y+=6; }
  }else{
    doc.setFont("courier","bold"); doc.setFontSize(10); doc.text("Bandas (topo → base):",40,y); y+=8;
    analysis.bands.forEach((b,i)=>{
      y+=18;
      doc.setFillColor(b.rgb[0],b.rgb[1],b.rgb[2]); doc.rect(40,y-10,28,12,"F");
      doc.setFont("courier","normal"); doc.setTextColor(31,42,20);
      doc.text(`${pad(i+1)}/10  ${rgbToHex(b.rgb)}  VLT ${b.vlt}%`,78,y);
    });
    y+=24;
    doc.text(`VLT topo: ${analysis.bands[0].vlt}% (filtro ${100-analysis.bands[0].vlt}%)   VLT base: ${analysis.bands[9].vlt}% (filtro ${100-analysis.bands[9].vlt}%)`,40,y);
    y+=22;
  }

  const matches=[...$("matchList").querySelectorAll(".nm")].map(n=>n.textContent);
  doc.setFont("courier","bold"); doc.text("Cores semelhantes:",40,y); y+=16;
  doc.setFont("courier","normal");
  if(matches.length){ matches.forEach(m=>{doc.text("• "+m,46,y);y+=15;}); }
  else { doc.text("Nenhuma cor próxima no banco de dados.",46,y); y+=15; }

  const fname=`SAO_${sao}_OS_${os}_${st.date}_${st.time}.pdf`;

  const blob=doc.output("blob");

  // ----- Delivery: try native share first; if that path isn't usable in this
  // in-app browser, embed the PDF directly on the page so it can be viewed and
  // long-pressed / shared. Anchors and window.open don't work in the webview. -----
  function embedFallback(append){
    try{
      // Use a base64 data-URI (not a blob: URL). In-app webviews refuse to
      // load blob: URLs in iframes/links, but a data-URI carries the bytes
      // inline so there is nothing to fetch.
      const dataUri = doc.output("datauristring");   // data:application/pdf;...;base64,XXXX
      const host=document.getElementById("pdfView");
      const embedHtml=
        '<object data="'+dataUri+'" type="application/pdf" '+
        'style="width:100%;height:70vh;border:1px solid var(--line);border-radius:10px;">'+
        '<p style="padding:12px;color:var(--mute);font-size:13px;">'+
        'Seu navegador não mostrou o PDF aqui. Use o botão abaixo para abri-lo numa nova aba, '+
        'onde poderá Compartilhar ou Salvar em Arquivos.</p>'+
        '</object>'+
        '<button type="button" id="pdfOpenTab" '+
        'style="margin-top:10px;width:100%;font-family:inherit;font-size:14px;font-weight:700;'+
        'padding:14px;border-radius:10px;border:1px solid var(--green);background:var(--green);color:#fff;">'+
        'Abrir PDF em nova aba</button>';
      if(append){ host.innerHTML += embedHtml; }
      else {
        host.innerHTML=embedHtml;
        $("saveMsg").textContent="PDF gerado abaixo. Se não aparecer, toque em 'Abrir PDF em nova aba'.";
      }
      host.classList.remove("hidden");
      if(!append) host.scrollIntoView({behavior:"smooth",block:"start"});
      // The button writes the PDF into a fresh document — works where iframes don't.
      const btn=document.getElementById("pdfOpenTab");
      if(btn){
        btn.addEventListener("click",()=>{
          try{
            const w=window.open();
            if(w && w.document){
              w.document.title=fname;
              w.document.body.style.margin="0";
              w.document.body.innerHTML=
                '<iframe src="'+dataUri+'" style="border:0;width:100vw;height:100vh;"></iframe>';
              $("saveMsg").textContent="PDF aberto em nova aba. Use Compartilhar para salvar.";
            }else{
              location.href=dataUri;
            }
          }catch(e3){
            location.href=dataUri;
          }
        });
      }
    }catch(e2){
      if(!append) $("saveMsg").textContent="Erro ao exibir o PDF: "+(e2 && e2.message ? e2.message : e2);
    }
  }

  // Build a plain-text summary of the order so it can always be copied into
  // WhatsApp / e-mail even if PDF delivery is blocked by the browser.
  function orderText(){
    let t="*Amostra de Cor Digital*\n";
    t+="SAO: "+sao+"   OS: "+os+"\n";
    t+="ACO (altura centro óptico): "+aco+" mm\n";
    if(transMm) t+="Transição do degradê: "+transMm+" mm\n";
    t+="Data: "+st.date+"  Hora: "+st.time+"\n";
    t+="Tipo: "+(lensType==="gradient"?"Degradê":"Sólida")+"\n";
    if(lensType==="solid"){
      const s=effectiveSolid();
      t+="HEX: "+rgbToHex(s.rgb)+"\n";
      t+="RGB: "+s.rgb.join(", ")+"\n";
      t+="CMYK: "+rgbToCmyk(s.rgb).join(" ")+"\n";
      t+="VLT: "+s.vlt+"%   Filtro: "+(100-s.vlt)+"%   Categoria "+categoryOf(s.vlt)+"\n";
      if(s.name) t+="Cor do banco: "+s.name+"\n";
    }
    return t;
  }

  let file=null;
  try{ file=new File([blob],fname,{type:"application/pdf"}); }catch(e){}

  // Decide upfront whether this browser can share the PDF file. canShare with a
  // file is the honest test for file support (unlike canShare() with no args).
  const canShareFile = !!(file && navigator.canShare && navigator.canShare({files:[file]}));

  if(canShareFile){
    navigator.share({files:[file], title:fname, text:orderText()})
      .then(()=>{ $("saveMsg").textContent="Enviado: "+fname; })
      .catch((err)=>{
        if(err && err.name==="AbortError"){ $("saveMsg").textContent="Envio cancelado."; }
        else { showManualOptions("O navegador recusou o envio do arquivo."); }
      });
  }else{
    // File sharing not available in this browser → go straight to the WhatsApp /
    // copy options, which work without file support.
    showManualOptions("Pronto para enviar.");
  }

  // Manual options shown when the browser blocks direct sharing: a copy-text
  // button (always works) plus the PDF embed attempt.
  function showManualOptions(reason){
    const host=document.getElementById("pdfView");
    host.innerHTML=
      '<p style="color:var(--mute);font-size:13px;margin:0 0 10px;">'+reason+
      ' Toque em WhatsApp para enviar os dados, ou copie para colar onde quiser.</p>'+
      '<button type="button" id="sendWhats" '+
      'style="width:100%;font-family:inherit;font-size:15px;font-weight:700;'+
      'padding:16px;border-radius:10px;border:none;background:#25D366;color:#fff;margin-bottom:10px;">'+
      'Enviar para WhatsApp</button>'+
      '<button type="button" id="copyOrder" '+
      'style="width:100%;font-family:inherit;font-size:14px;font-weight:700;'+
      'padding:14px;border-radius:10px;border:1px solid var(--green);background:var(--green);color:#fff;margin-bottom:10px;">'+
      'Copiar dados do pedido</button>';
    host.classList.remove("hidden");
    host.scrollIntoView({behavior:"smooth",block:"start"});

    // WhatsApp: open a chat with the fixed Zeiss number, text pre-filled.
    const ws=document.getElementById("sendWhats");
    if(ws){
      ws.addEventListener("click",()=>{
        const phone="5524992414573";   // 55 (BR) 24 99241-4573
        const url="https://wa.me/"+phone+"?text="+encodeURIComponent(orderText());
        // Copy too, as a safety net in case WhatsApp strips long text.
        try{ if(navigator.clipboard) navigator.clipboard.writeText(orderText()); }catch(e){}
        $("saveMsg").textContent="Abrindo o WhatsApp…";
        // location change is the most reliable way to leave an in-app webview.
        try{ window.location.href=url; }
        catch(e){ window.open(url,"_blank"); }
      });
    }

    const cb=document.getElementById("copyOrder");
    if(cb){
      cb.addEventListener("click",()=>{
        const txt=orderText();
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(txt)
            .then(()=>{ $("saveMsg").textContent="Dados copiados! Cole no WhatsApp ou e-mail."; })
            .catch(()=>{ legacyCopy(txt); });
        }else{ legacyCopy(txt); }
      });
    }
    function legacyCopy(txt){
      try{
        const ta=document.createElement("textarea");
        ta.value=txt; ta.style.position="fixed"; ta.style.opacity="0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        $("saveMsg").textContent="Dados copiados! Cole no WhatsApp ou e-mail.";
      }catch(e){ $("saveMsg").textContent="Copie manualmente:\n"+txt; }
    }
    // Also attempt to show the PDF for those browsers that allow it.
    embedFallback(true);
  }
  }catch(err){
    $("saveMsg").textContent="Erro ao gerar o PDF: "+(err && err.message ? err.message : err);
  }
}

$("btnRestart").addEventListener("click",()=>{
  analysis=null; img=null; off=null; outline=[]; $("file").value="";
  { const v=document.getElementById("pdfView"); if(v){ v.classList.add("hidden"); v.innerHTML=""; } }
  $("step-results").classList.add("hidden");
  $("step-isolate").classList.add("hidden");
  $("step-capture").classList.remove("hidden");
  $("saveMsg").textContent="";
});

/* ============================================================
   Boot: load the lens database before the app is usable.
   ============================================================ */
loadDB();
