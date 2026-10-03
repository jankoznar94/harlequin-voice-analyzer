
/** Systematicky: na kterých výškách YIN vybere špatnou harmonickou? */
import { yinFrame } from '../src/analysis.js';
const SR=48000, FRAME=2048, HOP=960;
function rng(seed){ let a=seed; return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function ampAt(f,F){ let a=0; for(const [fc,bw,g] of F) a+=g/(1+Math.pow((f-fc)/bw,2)); return a+0.02; }
function tone(f0,dur,F,{noise=3e-4,vibDepth=0.03,seed=5}={}){
  const n=Math.round(SR*dur),o=new Float64Array(n),r=rng(seed); let ph=0;
  for(let i=0;i<n;i++){ const inst=f0*(1+vibDepth*Math.sin(2*Math.PI*5.6*i/SR));
    ph+=2*Math.PI*inst/SR; let v=0;
    for(let h=1;h*inst<5200;h++) v+=ampAt(h*inst,F)*Math.sin(h*ph)/Math.sqrt(h);
    o[i]=0.28*v+(r()-0.5)*noise; }
  return o;
}
/** Vrátí převládající poměr f_výstup/f0 (1 = správně, 2 = oktáva výš, 0.5 = oktáva níž). */
function dominantRatio(f0,F,dur=1.6){
  const x=tone(f0,dur,F);
  const ratios=[];
  for(let o=0;o+FRAME<=x.length;o+=HOP){
    const fr=x.subarray(o,o+FRAME);
    let r0=0; for(let i=0;i<FRAME;i++) r0+=fr[i]*fr[i];
    if(Math.sqrt(r0/FRAME)<0.010) continue;
    const f=yinFrame(fr,SR,70,1200,0.15);
    if(f>0) ratios.push(f/f0);
  }
  if(!ratios.length) return { label:'nic', pct:0 };
  const cnt={}; for(const r of ratios){ const k=r.toFixed(2); cnt[k]=(cnt[k]||0)+1; }
  let best=null,n=0; for(const k in cnt) if(cnt[k]>n){ n=cnt[k]; best=+k; }
  return { best, pct: 100*n/ratios.length, n:ratios.length };
}
const FORMS={
  'a (700/1200/2600)': [[700,80,1],[1200,110,0.55],[2600,180,0.35]],
  'e (500/1900/2500)': [[500,70,1],[1900,120,0.6],[2500,160,0.35]],
  'i (300/2300/3000)': [[300,60,1],[2300,100,0.6],[3000,150,0.4]],
  'o (450/800/2600)':  [[450,70,1],[800,90,0.7],[2600,180,0.4]],
  'u (320/800/2400)':  [[320,60,1],[800,90,0.6],[2400,170,0.4]],
};
const NOTES=[]; let n=48; // A#3 (233) až B4 (494)
for(let m=58;m<=71;m++){ const f=440*Math.pow(2,(m-69)/12); NOTES.push([f, ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][m%12]+(Math.floor(m/12)-1)]); }
for(const [fname,F] of Object.entries(FORMS)){
  const bad=[];
  for(const [f,note] of NOTES){
    const r=dominantRatio(f,F);
    if(r.best && Math.abs(r.best-1)>0.06) bad.push(`${note}(${f.toFixed(0)}Hz)→${r.best}× ${r.pct.toFixed(0)}%`);
  }
  console.log(`${fname.padEnd(20)} chybných tónů: ${bad.length ? bad.join(', ') : 'žádný'}`);
}
