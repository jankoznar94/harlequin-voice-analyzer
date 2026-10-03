
/**
 * Mechanismus: YIN chytne druhou harmonickou, když je silnější než základní tón.
 * Test: pro pevné f0 se hýbe F1 a sleduje se, kdy se to stane.
 */
import { yinFrame, analyze } from '../src/analysis.js';
const SR=48000, FRAME=2048, HOP=960;
function rng(seed){ let a=seed; return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function ampAt(f,F){ let a=0; for(const [fc,bw,g] of F) a+=g/(1+Math.pow((f-fc)/bw,2)); return a+0.02; }
function tone(f0,dur,F,{noise=3e-4,vibDepth=0.025,seed=5,decay=0}={}){
  const n=Math.round(SR*dur),o=new Float64Array(n),r=rng(seed); let ph=0;
  for(let i=0;i<n;i++){ const inst=f0*(1+vibDepth*Math.sin(2*Math.PI*5.6*i/SR));
    ph+=2*Math.PI*inst/SR; let v=0;
    for(let h=1;h*inst<5200;h++){
      const d = decay? Math.pow(decay,h-1) : 1/Math.sqrt(h);
      v+=ampAt(h*inst,F)*d*Math.sin(h*ph); }
    o[i]=0.28*v+(r()-0.5)*noise; }
  return o;
}
const med=(a)=>{ const s=[...a].sort((p,q)=>p-q); return s.length? s[s.length>>1]:NaN; };

console.log('=== 1. Kdy YIN chytne 2. harmonickou? (F1 se hýbe, f0 = 330 Hz) ===');
console.log('   F1     poměr f0H1/f0H2    YIN       poměr výstupu');
for(const F1 of [400,500,600,650,700,750,800,900,1000]){
  const F=[[F1,80,1],[1200,110,0.55],[2600,180,0.35]];
  const a1=ampAt(330,F)/1, a2=ampAt(660,F)/Math.sqrt(2);
  const x=tone(330,1.5,F);
  const out=[];
  for(let o=0;o+FRAME<=x.length;o+=HOP){
    const fr=x.subarray(o,o+FRAME);
    let r0=0; for(let i=0;i<FRAME;i++) r0+=fr[i]*fr[i];
    if(Math.sqrt(r0/FRAME)<0.010) continue;
    const f=yinFrame(fr,SR,70,1200,0.15); if(f>0) out.push(f/330);
  }
  console.log(`   ${String(F1).padStart(4)}     H1 ${a1.toFixed(3)} H2 ${a2.toFixed(3)} (H2/H1 ${(a2/a1).toFixed(2)})   ${med(out).toFixed(2)}×   ${out.length? (100*out.filter(r=>Math.abs(r-1)<0.06).length/out.length).toFixed(0)+'% správně':'nic'}`);
}

console.log('\n=== 2. Totéž pro skutečný rozsah tónů, F1 = 700 Hz (á) ===');
console.log('   f0     H2/H1    YIN medián   offline nález');
for(const f0 of [196,220,247,262,294,330,349,392,440]){
  const F=[[700,80,1],[1200,110,0.55],[2600,180,0.35]];
  const a1=ampAt(f0,F), a2=ampAt(2*f0,F)/Math.sqrt(2);
  const x=tone(f0,2.0,F);
  const out=[];
  for(let o=0;o+FRAME<=x.length;o+=HOP){
    const fr=x.subarray(o,o+FRAME);
    let r0=0; for(let i=0;i<FRAME;i++) r0+=fr[i]*fr[i];
    if(Math.sqrt(r0/FRAME)<0.010) continue;
    const f=yinFrame(fr,SR,70,1200,0.15); if(f>0) out.push(f/f0);
  }
  const res=analyze(x,SR,{fach:'tenor'});
  const found=res.notes.length? res.notes.map(n=>n.note).join(',') : '— ŽÁDNÝ TÓN —';
  console.log(`   ${String(f0).padStart(4)}   ${(a2/a1).toFixed(2)}     ${out.length?med(out).toFixed(2)+'×':'nic'}       ${found}`);
}
