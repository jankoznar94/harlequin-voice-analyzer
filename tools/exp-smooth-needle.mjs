
/**
 * Vyhlazení ručičky ladění — kolik cukání ubere a co to stojí.
 *
 * Cukání ručičky naměřené dřív: medián skoku 32 c, 90. percentil 89 c.
 * Cílem je dostat 90. percentil dolů, aniž by ručička začala viditelně
 * zaostávat (u zpěvu je 40–60 ms přijatelné, nad 100 ms už ne).
 */
import { yinFrame } from '../src/analysis.js';
const SR=48000, FRAME=2048, HOP=960;
function rng(seed){ let a=seed; return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const FORM=[[700,80,1],[1200,110,0.55],[2600,180,0.35]];
function ampAt(f){ let a=0; for(const [fc,bw,g] of FORM) a+=g/(1+Math.pow((f-fc)/bw,2)); return a+0.02; }
/** Fráze s vibratem a přechody (glissando) — přechod je to, co nesmí zaostávat. */
function phrase(){
  const segs=[[392,0.8,0.03],[392,0.6,0.0],[440,0.9,0.03],[466,0.7,0.03],[523,0.8,0.03]];
  const parts=[];
  for(const [f0,d,vib] of segs){
    const n=Math.round(SR*d), o=new Float64Array(n); let ph=0;
    for(let i=0;i<n;i++){
      const env=Math.min(1,i/(0.03*SR))*Math.min(1,(n-i)/(0.04*SR));
      const inst=vib? f0*(1+vib*Math.sin(2*Math.PI*5.6*i/SR)) : f0;
      ph+=2*Math.PI*inst/SR; let v=0;
      for(let h=1;h*inst<5200;h++) v+=ampAt(h*inst)*Math.sin(h*ph)/Math.sqrt(h);
      o[i]=0.26*v*env;
    }
    parts.push(o);
  }
  // plynulý skok o oktávu nahoru — test, že vyhlazení nezdrží reakci
  const n=Math.round(SR*0.7), glide=new Float64Array(n); let ph=0;
  for(let i=0;i<n;i++){ const t=i/(n-1); const inst=523*Math.pow(2,t);
    ph+=2*Math.PI*inst/SR; let v=0;
    for(let h=1;h*inst<5200;h++) v+=ampAt(h*inst)*Math.sin(h*ph)/Math.sqrt(h);
    glide[i]=0.26*v; }
  parts.push(glide);
  const total=parts.reduce((a,b)=>a+b.length,0), x=new Float64Array(total);
  let off=0; for(const p of parts){ x.set(p,off); off+=p.length; }
  return x;
}
function cents(f0){ const midi=Math.round(12*Math.log2(f0/440)+69); const t=440*Math.pow(2,(midi-69)/12); return 1200*Math.log2(f0/t); }
const med=(a)=>{ const s=[...a].sort((p,q)=>p-q); return s.length?s[s.length>>1]:NaN; };
const pct=(a,p)=>{ const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.min(s.length-1,Math.floor(p*s.length))] : NaN; };

const x=phrase();
const raw=[];
for(let o=0;o+FRAME<=x.length;o+=HOP){
  const fr=x.subarray(o,o+FRAME);
  let r0=0; for(let i=0;i<FRAME;i++) r0+=fr[i]*fr[i];
  if(Math.sqrt(r0/FRAME)<0.010){ raw.push(null); continue; }
  const f=yinFrame(fr,SR,70,1200,0.15);
  raw.push(f>0? cents(f) : null);
}
const diffsOf=(seq)=>{ const d=[]; for(let i=1;i<seq.length;i++) if(seq[i]!=null&&seq[i-1]!=null) d.push(Math.abs(seq[i]-seq[i-1])); return d; };
const d0=diffsOf(raw);
console.log(`surová ručička:         medián ${med(d0).toFixed(0)} c, 90. pctl ${pct(d0,0.9).toFixed(0)} c, max ${Math.max(...d0).toFixed(0)} c`);

console.log('\nvarianta N=3 (medián 3 rámců, zpoždění ~20 ms):');
for(const N of [2,3,5,7]){
  const out=[];
  for(let i=0;i<raw.length;i++){
    const w=raw.slice(Math.max(0,i-N+1),i+1).filter(v=>v!=null);
    out.push(w.length? med(w) : null);
  }
  const d=diffsOf(out);
  // zpoždění na skoku: porovnej, kde se objeví nová hodnota
  let firstRaw=raw.findIndex((v,i)=>i>0&&v!=null&&raw[i-1]!=null&&Math.abs(v-raw[i-1])>200);
  let firstSm=out.findIndex((v,i)=>i>0&&v!=null&&out[i-1]!=null&&Math.abs(v-out[i-1])>100);
  console.log(`  N=${N}: medián ${med(d).toFixed(0)} c, 90. pctl ${pct(d,0.9).toFixed(0)} c, max ${Math.max(...d).toFixed(0)} c   (zpoždění ${((N-1)/2*20).toFixed(0)} ms)`);
}

console.log('\nvážené vyhlazení (EMA) — reaguje svižněji na změnu:');
for(const alpha of [0.5,0.35,0.25,0.15]){
  let ema=null; const out=[];
  for(const v of raw){
    if(v==null){ out.push(null); continue; }
    ema = ema==null? v : ema + alpha*(v-ema);
    out.push(ema);
  }
  const d=diffsOf(out);
  console.log(`  alpha=${alpha}: medián ${med(d).toFixed(0)} c, 90. pctl ${pct(d,0.9).toFixed(0)} c, max ${Math.max(...d).toFixed(0)} c   (zpoždění ~${(1/alpha).toFixed(1)} rámců = ${(20/alpha).toFixed(0)} ms)`);
}
