import React, { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import jsPDF from "jspdf";
import Tesseract from "tesseract.js";
import { Toaster, toast } from "sonner";

// =============================================================
//  APP — PDF→IMMAGINI + OCR potenziato per manoscritti
//  - Estrae immagini da PDF scannerizzati (SOI/EOI) 100% locale
//  - Anteprima multi-pagina con navigazione (Pagina X di Y)
//  - OCR "ensemble" multi-variante (upscale, binarizza, rotazioni, contrasto)
//  - Contatore di confidenza (pagina e globale) + evidenziatore campi incerti
//  - Estrazione importo + eredi (pattern aggiuntivi) + Export PDF/CSV
// =============================================================

// ===== Util =====
const fmtEUR = (n:number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(isFinite(n) ? n : 0);
const fmtPCT = (v:number) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(2).replace('.', ',')}%` : "—");
const parseNumberIT = (s:any) => { if (s == null) return null; const cleaned = String(s).replace(/\./g, "").replace(/,/, "."); const v = parseFloat(cleaned); return isNaN(v) ? null : v; };
const dl = (filename:string, text:string, type='text/csv;charset=utf-8') => { const blob = new Blob([text], {type}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); URL.revokeObjectURL(url); };
const asArray = <T,>(x:any, fallback:T[] = []): T[] => Array.isArray(x) ? (x as T[]) : fallback;
const sleep = (ms:number)=> new Promise(r=>setTimeout(r,ms));
const withTimeout = async <T,>(p:Promise<T>, ms:number, label:string): Promise<T> => new Promise<T>((resolve, reject)=>{
  const id = setTimeout(()=>reject(new Error(label+" timeout")), ms);
  p.then(v=>{ clearTimeout(id); resolve(v); }).catch(e=>{ clearTimeout(id); reject(e); });
});

// ===== File → dataURL =====
async function blobToDataUrlSafe(b: Blob): Promise<string>{
  return await new Promise<string>((resolve,reject)=>{
    const fr = new FileReader();
    fr.onerror = ()=>reject(new Error('FileReader failed'));
    fr.onload = ()=>resolve(String(fr.result||''));
    fr.readAsDataURL(b);
  });
}

// ===== PDF → immagini (estrazione JPEG interne: SOI FFD8 / EOI FFD9) =====
async function extractJpegDataUrlsFromPdf(buf: ArrayBuffer): Promise<string[]>{
  const bytes = new Uint8Array(buf);
  const urls: string[] = [];
  for(let i=0;i<bytes.length-1;i++){
    if(bytes[i]===0xFF && bytes[i+1]===0xD8){
      for(let j=i+2;j<bytes.length-1;j++){
        if(bytes[j]===0xFF && bytes[j+1]===0xD9){
          try{
            const slice = bytes.slice(i, j+2);
            const blob = new Blob([slice], {type:'image/jpeg'});
            const dataUrl = await blobToDataUrlSafe(blob);
            urls.push(dataUrl);
          }catch{}
          i = j+1; break;
        }
      }
    }
  }
  return urls;
}

// ===== Pre-processing immagini =====
function toGray(c:HTMLCanvasElement){ const x=c.getContext('2d')!; const i=x.getImageData(0,0,c.width,c.height), d=i.data; for(let k=0;k<d.length;k+=4){ const g=d[k]*0.3+d[k+1]*0.59+d[k+2]*0.11; d[k]=d[k+1]=d[k+2]=g; } x.putImageData(i,0,0); return c; }
function binarize(c:HTMLCanvasElement, k=0.96){ const x=c.getContext('2d')!; const i=x.getImageData(0,0,c.width,c.height), d=i.data; const cp=new Uint8ClampedArray(d.length); cp.set(d); const w=c.width,h=c.height,win=6; for(let y=0;y<h;y++){ for(let x0=0;x0<w;x0++){ let sum=0,cnt=0; for(let yy=Math.max(0,y-win);yy<=Math.min(h-1,y+win);yy++){ for(let xx=Math.max(0,x0-win);xx<=Math.min(w-1,x0+win);xx++){ sum+=cp[(yy*w+xx)*4]; cnt++; } } const idx=(y*w+x0)*4; const mean=sum/cnt; const v = cp[idx] < mean*k ? 0 : 255; d[idx]=d[idx+1]=d[idx+2]=v; } } x.putImageData(i,0,0); return c; }
function adjustContrast(c:HTMLCanvasElement, f=1.45){ const x=c.getContext('2d')!; const i=x.getImageData(0,0,c.width,c.height), d=i.data; const F=(259*(f+255))/(255*(259-f)); for(let k=0;k<d.length;k+=4){ for(let j=0;j<3;j++){ const v=F*(d[k+j]-128)+128; d[k+j]=v<0?0:(v>255?255:v); } } x.putImageData(i,0,0); return c; }
function dilate3x3(c:HTMLCanvasElement){ const x=c.getContext('2d')!; const i=x.getImageData(0,0,c.width,c.height), d=i.data; const w=c.width,h=c.height; const out=new Uint8ClampedArray(d.length); for(let y=0;y<h;y++){ for(let x0=0;x0<w;x0++){ let maxv=0; for(let yy=y-1;yy<=y+1;yy++){ for(let xx=x0-1;xx<=x0+1;xx++){ if(xx>=0&&yy>=0&&xx<w&&yy<h){ const vv=d[(yy*w+xx)*4]; if(vv>maxv) maxv=vv; } } } const idx=(y*w+x0)*4; out[idx]=out[idx+1]=out[idx+2]=maxv; out[idx+3]=255; } } i.data.set(out); x.putImageData(i,0,0); return c; }
function rotateCanvas(src:HTMLCanvasElement, deg:number){ const rad=deg*Math.PI/180, s=Math.abs(Math.sin(rad)), c=Math.abs(Math.cos(rad)); const w=src.width,h=src.height; const nw=Math.floor(w*c+h*s), nh=Math.floor(w*s+h*c); const out=document.createElement('canvas'); out.width=nw; out.height=nh; const g=out.getContext('2d')!; g.translate(nw/2,nh/2); g.rotate(rad); g.drawImage(src,-w/2,-h/2); return out; }
function upscaleCanvas(src:HTMLCanvasElement, scale=2.6){ const out=document.createElement('canvas'); out.width=Math.floor(src.width*scale); out.height=Math.floor(src.height*scale); const g=out.getContext('2d')!; g.imageSmoothingEnabled=true; g.drawImage(src,0,0,out.width,out.height); return out; }

// ===== OCR ensemble multi-variante =====
async function ocrBestOf(dataUrl:string, onStatus?:(s:string)=>void){
  const PASS_TIMEOUT=12000;
  const variants: {label:string, url:string}[] = [];
  try{
    const img=new Image(); img.src=dataUrl; await img.decode();
    const base=document.createElement('canvas'); base.width=img.width; base.height=img.height; base.getContext('2d')!.drawImage(img,0,0);
    const ups=[2.2,2.8,3.2], rots=[-2,-1,0,1,2], ks=[0.94,0.96,0.985];
    for(const sc of ups){ for(const rot of rots){ let c=upscaleCanvas(base,sc); c=toGray(c); if(rot!==0) c=rotateCanvas(c,rot);
      variants.push({label:`gray s${sc} r${rot}`, url:c.toDataURL('image/png')});
      for(const k of ks){ const b=binarize(c.cloneNode(true) as HTMLCanvasElement,k); variants.push({label:`bin k${k} s${sc} r${rot}`, url:(b as HTMLCanvasElement).toDataURL('image/png')}); }
      const cd=dilate3x3(binarize(c.cloneNode(true) as HTMLCanvasElement,0.96)); variants.push({label:`dilate s${sc} r${rot}`, url:cd.toDataURL('image/png')});
      const cc=adjustContrast((c.cloneNode(true) as HTMLCanvasElement),1.45); variants.push({label:`contrast s${sc} r${rot}`, url:cc.toDataURL('image/png')});
    } }
  }catch{ variants.push({label:'original',url:dataUrl}); }

  let best={ text:'', conf:-1, label:'' } as any;
  for(let i=0;i<variants.length;i++){
    const v=variants[i]; onStatus?.(`OCR variante ${i+1}/${variants.length} (${v.label})…`);
    try{
      const r:any=await withTimeout(Tesseract.recognize(v.url,'ita+eng',{logger:()=>{}}),PASS_TIMEOUT,'OCR');
      const conf=Number(r?.data?.confidence||0); const text=String(r?.data?.text||'');
      if(conf>best.conf){ best={text,conf,label:v.label}; }
      if(conf>=96 && /%|\d+\s*\/\s*\d+/.test(text)) break; // early stop se molto buono
    }catch{}
  }
  if(best.conf<0){ // fallback estremo
    try{ const r:any=await withTimeout(Tesseract.recognize(dataUrl,'ita+eng',{logger:()=>{}}),PASS_TIMEOUT,'OCRfallback'); best={ text:String(r?.data?.text||''), conf:Number(r?.data?.confidence||0), label:'fallback' }; }catch{}
  }
  return best;
}

// ===== Regex di estrazione =====
const RGX_AMOUNT = /(?:capitale(?:\s+assicurato)?|importo\s+(?:liquidabile|lordo)?|somma\s+assicurata|massimale)[^0-9€]*€?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2}))/i;
const RGX_HEIR  = /(Coniuge|Figlio|Figlia|Convivente|Padre|Madre|Fratello|Sorella|Nipote|Erede)[^%\n]*?([A-ZÀ-Ý][A-Za-zÀ-ÿ']+\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ']+)?[^%\n]*?(\d{1,3}(?:[\.,]\d+)?|\d+\/\d+|(?:un|uno|due|tre|quattro)\s+(?:terzo|terzi|quarto|quarti))/i;
const RGX_HEIR2 = /([A-ZÀ-Ý][A-Za-zÀ-ÿ']+\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ']+)\s*[-–:]?\s*(\d{1,3}(?:[\.,]\d+)?|\d+\/\d+)\s*%?/gmi;
const RGX_HEIR3 = /([A-ZÀ-Ý]{2,}\s+[A-ZÀ-Ý]{2,})\s*[-–:]?\s*(\d{1,3}(?:[\.,]\d+)?|\d+\/\d+)\s*%?/gmi;

function fractionToPercent(s:string){ const m=s.match(/(\d+)\s*\/\s*(\d+)/); if(!m) return null; const a=+m[1], b=+m[2]; if(!b) return null; return +(100*(a/b)).toFixed(2); }
function wordsToPercent(s:string){ const low=s.toLowerCase(); if(/un|uno\s+terz/.test(low)) return 33.33; if(/due\s+terz/.test(low)) return 66.67; if(/quattro\s+quarti/.test(low)) return 100.00; return null; }

function extractData(text:string){
  const lines = (text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const joined = lines.join('\n');
  const am = joined.match(RGX_AMOUNT);
  const gross = am? parseNumberIT(am[1]) : undefined;
  const heirs:any[] = [];
  for(const l of lines){ const m=l.match(RGX_HEIR); if(m){
    const rapporto=m[1]; const nome=(m[2]||'').trim(); const raw=(m[3]||'').trim();
    let pct:number|undefined;
    if(/\d+\s*\/\s*\d+/.test(raw)) pct=fractionToPercent(raw)||undefined;
    else if(/%|per\s*cento/i.test(raw) || /\d/.test(raw)) { const num=parseFloat(raw.replace(/\./g,'').replace(',','.')); if(isFinite(num)) pct=+num.toFixed(2); }
    else { const w=wordsToPercent(raw); if(w!=null) pct=w; }
    heirs.push({ rapporto, nome, percentuale: pct!=null? String(pct) : '' });
  } }
  let m:any;
  while((m = RGX_HEIR2.exec(joined))){ const nome=(m[1]||'').trim(); const raw=String(m[2]||''); let pct:any=''; if(/\d+\s*\/\s*\d+/.test(raw)){ const v=fractionToPercent(raw); if(v!=null) pct=String(v); } else { const n=parseFloat(raw.replace(/\./g,'').replace(',','.')); if(isFinite(n)) pct=String(+n.toFixed(2)); } heirs.push({ rapporto:'', nome, percentuale:pct }); }
  while((m = RGX_HEIR3.exec(joined))){ const nome=(m[1]||'').trim(); const raw=String(m[2]||''); let pct:any=''; if(/\d+\s*\/\s*\d+/.test(raw)){ const v=fractionToPercent(raw); if(v!=null) pct=String(v); } else { const n=parseFloat(raw.replace(/\./g,'').replace(',','.')); if(isFinite(n)) pct=String(+n.toFixed(2)); } heirs.push({ rapporto:'', nome, percentuale:pct }); }
  return { grossAmount: gross, heirs };
}

// ===== Component =====
export default function App(){
  const [files,setFiles]=useState<File[]>([]);
  const [fileIdx,setFileIdx]=useState(0);
  const [pageImages,setPageImages]=useState<string[]>([]);
  const [pageIdx,setPageIdx]=useState(0);
  const [pageConfs,setPageConfs]=useState<number[]>([]); // confidenza per pagina
  const [rows,setRows]=useState<any[]>([]);
  const [lordo,setLordo]=useState('');
  const [status,setStatus]=useState('Pronto');
  const [busy,setBusy]=useState(false);
  const [missing,setMissing]=useState<string[]>([]);
  const [rawText,setRawText]=useState('');

  const lordoNum=parseNumberIT(lordo)||0;
  const somma=asArray(rows).reduce((a,r)=>a+(parseFloat(r.percentuale)||0),0);
  const totale=asArray(rows).reduce((a,r)=>a+(lordoNum*((parseFloat(r.percentuale)||0)))/100,0);
  const maxConf = pageConfs.length? Math.max(...pageConfs.filter(v=>isFinite(v))) : null;

  useEffect(()=>{ setPageImages([]); setPageConfs([]); setPageIdx(0); setRawText(''); setRows([]); setMissing([]); },[files,fileIdx]);

  async function preparePreview(){
    const f=files[fileIdx]; if(!f){ toast.error('Nessun file'); return; }
    setStatus('1/3 Conversione…');
    const name=(f.name||'').toLowerCase(); const type=(f.type||'').toLowerCase();
    const isImg = /^image\//.test(type) || /\.(png|jpe?g|webp|bmp|gif|tif?f|heic)$/.test(name);
    const isPdf = type==='application/pdf' || name.endsWith('.pdf');
    let previews:string[]=[];
    try{
      if(isImg){ const dataUrl=await blobToDataUrlSafe(f); previews=[dataUrl]; }
      else if(isPdf){ const buf=await f.arrayBuffer(); previews = await extractJpegDataUrlsFromPdf(buf); if(previews.length===0){ toast.message('PDF senza immagini interne: non convertibile qui'); } }
      else { const dataUrl=await blobToDataUrlSafe(f); previews=[dataUrl]; }
      setPageImages(previews); setPageConfs(new Array(previews.length).fill(NaN)); setStatus(previews.length? 'Pronto' : 'Nessuna pagina convertita');
    }catch(e){ console.error(e); setStatus('Errore conversione'); }
  }

  async function ocrCurrentPage(){
    if(busy) return; if(pageImages.length===0){ toast.error('Nessuna pagina'); return; }
    setBusy(true); try{
      setStatus(`2/3 OCR pagina ${pageIdx+1}/${pageImages.length}…`);
      const best = await ocrBestOf(pageImages[pageIdx], (s)=>setStatus(`2/3 Pag. ${pageIdx+1}/${pageImages.length} — ${s}`));
      setPageConfs(prev=>{ const next=[...prev]; next[pageIdx]=best.conf||0; return next; });
      const newText = ((rawText||'')+'\n'+(best.text||'')).trim(); setRawText(newText);
      postExtract(newText);
      setStatus('Pronto');
    }catch(e){ console.error(e); toast.error('Errore OCR pagina'); setStatus('Pronto'); }
    finally{ setBusy(false); }
  }

  async function ocrAllPages(){
    if(busy) return; if(pageImages.length===0){ toast.error('Nessuna pagina'); return; }
    setBusy(true); try{
      let texts:string[]=[]; const confs:number[]=[];
      for(let i=0;i<pageImages.length;i++){
        setStatus(`2/3 OCR pagina ${i+1}/${pageImages.length}…`);
        const best = await ocrBestOf(pageImages[i], (s)=>setStatus(`2/3 Pag. ${i+1}/${pageImages.length} — ${s}`));
        texts.push(best.text||''); confs[i]=best.conf||0; await sleep(5);
      }
      setPageConfs(confs);
      const newText = texts.join('\n').trim(); setRawText(newText);
      postExtract(newText);
      setStatus('Pronto');
    }catch(e){ console.error(e); toast.error('Errore OCR documento'); setStatus('Pronto'); }
    finally{ setBusy(false); }
  }

  function postExtract(fullText:string){
    const ext = extractData(fullText||'');
    if(ext.grossAmount!=null) setLordo(ext.grossAmount.toFixed(2).replace('.',','));
    const mapped = asArray<any>(ext.heirs).map(h=>({id:uuidv4(), nome:h.nome||'', rapporto:h.rapporto||'', percentuale:h.percentuale||''}));
    setRows(mapped);
    const miss:string[]=[]; if(!(ext.grossAmount!=null)) miss.push('Importo lordo non trovato');
    for(const r of mapped){ if(!r.nome) miss.push('Nome mancante'); if(!r.percentuale) miss.push('Percentuale mancante'); }
    setMissing(miss);
  }

  function scaricaPdf(){ const rws=asArray(rows); if(!rws.length){ toast.error('Niente da esportare'); return; }
    const doc=new jsPDF({unit:'pt',format:'a4'}); let y=50;
    doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.text('Riepilogo liquidazione polizza',50,y); y+=24;
    doc.setFont('helvetica','normal'); doc.setFontSize(11);
    doc.text(`Importo lordo: ${fmtEUR(lordoNum)}`,50,y); y+=20;
    for(const r of rws){ const imp=(lordoNum*(parseFloat(r.percentuale)||0))/100; doc.text(`${r.nome||'—'} ${r.rapporto||''} ${(parseFloat(r.percentuale)||0).toFixed(2).replace('.',',')}% → ${fmtEUR(imp)}`,50,y); y+=16; }
    doc.save('riepilogo.pdf');
  }

  function scaricaCSV(){ const rws=asArray(rows); if(!rws.length){ toast.error('Niente da esportare'); return; }
    const header=['Nome','Rapporto','Percentuale','Importo'];
    const out=rws.map(r=>{const imp=(lordoNum*(parseFloat(r.percentuale)||0))/100; return [r.nome||'',r.rapporto||'',(parseFloat(r.percentuale)||0).toFixed(2).replace('.',','),String(imp.toFixed(2)).replace('.',',')].join(';');});
    dl('riparto.csv',[header.join(';'),...out].join('\n'));
  }

  return (
    <div style={{padding:16}}>
      <Toaster richColors position="top-right"/>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8,flexWrap:'wrap'}}>
        <h2 style={{margin:0}}>Liquidazione polizza – Riparto eredi</h2>
        <div style={{color:'#6b7280'}}>
          {status}
          {maxConf!=null && isFinite(maxConf) ? ` — Conf. migliore: ${maxConf.toFixed(1)}%` : ''}
        </div>
      </div>

      <div style={{marginBottom:8, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <label style={{padding:'6px 10px',border:'1px solid #d1d5db',borderRadius:6,background:'#f3f4f6',cursor:'pointer'}}>
          📁 Scegli i file
          <input type="file" multiple onChange={e=>{setFiles(Array.from(e.target.files||[])); setFileIdx(0);}} style={{display:'none'}}/>
        </label>
        <button onClick={preparePreview} disabled={!files.length || busy}>{busy? 'In corso…' : 'Prepara anteprima'}</button>
        <button onClick={ocrAllPages} disabled={!pageImages.length || busy}>Leggi tutte le pagine</button>
        <button onClick={ocrCurrentPage} disabled={!pageImages.length || busy}>Leggi questa pagina</button>
      </div>

      {/* Preview */}
      {pageImages.length>0 && (
        <div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <div style={{fontSize:12,color:'#6b7280'}}>
              Pagine convertite: Pagina {pageIdx+1} di {pageImages.length}
              {isFinite(pageConfs[pageIdx]) ? ` — Conf. pagina: ${Number(pageConfs[pageIdx]).toFixed(1)}%` : ''}
            </div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              <button onClick={()=>setPageIdx(i=>Math.max(0,i-1))} disabled={pageIdx<=0}>◀</button>
              <button onClick={()=>setPageIdx(i=>Math.min(pageImages.length-1,i+1))} disabled={pageIdx>=pageImages.length-1}>▶</button>
            </div>
          </div>
          <img src={pageImages[pageIdx]} alt={`pagina ${pageIdx+1}`} style={{maxWidth:'100%',height:'auto',border:'1px solid #ddd'}}/>
        </div>
      )}

      {missing.length>0 && (
        <div style={{margin:'8px 0',padding:8,border:'1px solid #fecaca',borderRadius:6,color:'#991b1b',background:'#fff1f2'}}>
          <b>Campi mancanti o incerti:</b>
          <ul>{missing.map((m,i)=>(<li key={i}>{m}</li>))}</ul>
        </div>
      )}

      {rows.length>0 && (
        <table style={{marginTop:8,borderCollapse:'collapse',width:'100%'}}>
          <thead><tr><th>Nome</th><th>Rapporto</th><th style={{textAlign:'right'}}>%</th><th style={{textAlign:'right'}}>Importo</th></tr></thead>
          <tbody>
            {rows.map((r,i)=>(
              <tr key={r.id||i} style={{background:(!r.nome||!r.percentuale)?'#fff1f2':'transparent'}}>
                <td><input value={r.nome} onChange={e=>setRows(prev=>prev.map((x,j)=>j===i?{...x,nome:e.target.value}:x))}/></td>
                <td><input value={r.rapporto} onChange={e=>setRows(prev=>prev.map((x,j)=>j===i?{...x,rapporto:e.target.value}:x))}/></td>
                <td style={{textAlign:'right'}}><input value={r.percentuale} onChange={e=>setRows(prev=>prev.map((x,j)=>j===i?{...x,percentuale:e.target.value}:x))} style={{textAlign:'right',width:100}}/></td>
                <td style={{textAlign:'right'}}>{lordoNum? fmtEUR((lordoNum*(parseFloat(r.percentuale)||0))/100):'—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{marginTop:8}}>Somma percentuali: {fmtPCT(parseFloat(Number(somma).toFixed(2)))}</div>
      <div>Totale calcolato: {lordoNum? fmtEUR(totale):'—'}</div>

      <div style={{marginTop:8,display:'flex',gap:8}}>
        <button onClick={scaricaPdf}>Scarica PDF</button>
        <button onClick={scaricaCSV}>Esporta CSV</button>
      </div>

      {rawText && (
        <details style={{marginTop:12}}>
          <summary>Testo OCR grezzo</summary>
          <textarea value={rawText} onChange={e=>setRawText(e.target.value)} style={{width:'100%',height:150}}/>
        </details>
      )}
    </div>
  );
}
