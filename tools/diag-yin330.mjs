
/** Proč YIN na 330 Hz vrací půlku? Rozbor CMND. */
import { yinFrame, fft } from '../src/analysis.js';
const SR=48000, FRAME=2048;
function rng(seed){ let a=seed; return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const FORM=[[700,80,1],[1200,110,0.55],[2600,180,0.35]];
function ampAt(f){ let a=0; for(const [fc,bw,g] of FORM) a+=g/(1+Math.pow((f-fc)/bw,2)); return a+0.02; }
function tone(f0,dur,{noise=3e-4,vibDepth=0,seed=5}={}){
  const n=Math.round(SR*dur),o=new Float64Array(n),r=rng(seed); let ph=0;
  for(let i=0;i<n;i++){ const inst=vibDepth? f0*(1+vibDepth*Math.sin(2*Math.PI*5.6*i/SR)) : f0;
    ph+=2*Math.PI*inst/SR; let v=0;
    for(let h=1;h*inst<5200;h++) v+=ampAt(h*inst)*Math.sin(h*ph)/Math.sqrt(h);
    o[i]=0.28*v+(r()-0.5)*noise; }
  return o;
}
/* Zopakuje výpočet CMND, aby se dalo podívat dovnitř. */
function cmndOf(frame, sr, fMin, fMax){
  const N=frame.length, W=N>>1;
  const tauMax=Math.min(W,Math.ceil(sr/fMin)), tauMin=Math.max(2,Math.floor(sr/fMax));
  const pad=N<<1;
  const ar=new Float64Array(pad),ai=new Float64Array(pad),br=new Float64Array(pad),bi=new Float64Array(pad);
  for(let i=0;i<W;i++) ar[i]=frame[i];
  for(let i=0;i<N;i++) br[i]=frame[i];
  fft(ar,ai); fft(br,bi);
  const cr=new Float64Array(pad),ci=new Float64Array(pad);
  for(let i=0;i<pad;i++){ cr[i]=ar[i]*br[i]+ai[i]*bi[i]; ci[i]=ai[i]*br[i]-ar[i]*bi[i]; }
  // ifft
  for(let i=0;i<pad;i++){ ci[i]=-ci[i]; }
  fft(cr,ci);
  for(let i=0;i<pad;i++) cr[i]/=pad;
  const csum=new Float64Array(N+1);
  for(let i=0;i<N;i++) csum[i+1]=csum[i]+frame[i]*frame[i];
  const e0=csum[W];
  const d=new Float64Array(tauMax), cmnd=new Float64Array(tauMax);
  cmnd[0]=1;
  let run=0;
  for(let tau=1;tau<tauMax;tau++){
    let e=csum[tau+W]-csum[tau]; d[tau]=Math.max(0,e0+e-2*cr[tau]);
    run+=d[tau]; cmnd[tau]= run>0? d[tau]*tau/run : 1;
  }
  return { cmnd, tauMin, tauMax, d };
}
const x=tone(330,1.0);
const frame=x.subarray(2048,4096);
const { cmnd, tauMin, tauMax } = cmndOf(frame,SR,70,1200);
const f0=330;
console.log(`rámec 330 Hz: YIN vrací ${yinFrame(frame,SR,70,1200,0.15).toFixed(1)} Hz`);
console.log(`tauMin=${tauMin} (1200 Hz), tauMax=${tauMax} (70 Hz)`);
console.log('\nCMND v okolí skutečné periody a jejího dvojnásobku:');
for(const t of [Math.round(SR/f0), Math.round(SR/(f0/2)), Math.round(SR/(f0*2))]){
  const a=Math.max(1,t-4), b=Math.min(tauMax-1,t+4);
  const row=[]; for(let i=a;i<=b;i++) row.push(`${i}:${cmnd[i].toFixed(3)}`);
  console.log(`  tau=${t} (${(SR/t).toFixed(0)} Hz): ${row.join(' ')}`);
}
// nejnižší hodnota v celém rozsahu
let bi=tauMin; for(let t=tauMin;t<tauMax;t++) if(cmnd[t]<cmnd[bi]) bi=t;
console.log(`\nnejnižší CMND v rozsahu: tau=${bi} → ${(SR/bi).toFixed(1)} Hz, cmnd=${cmnd[bi].toFixed(4)}`);
let first=-1; for(let t=tauMin;t<tauMax;t++){ if(cmnd[t]<0.15){ first=t; break; } }
console.log(`první tau pod prahem 0.15: ${first} → ${first>0?(SR/first).toFixed(1):'-'} Hz, cmnd=${first>0?cmnd[first].toFixed(4):'-'}`);
console.log(`\nposledních 20 tau před tauMax: ${Array.from({length:20},(_,k)=>{const t=tauMax-20+k; return `${t}:${cmnd[t].toFixed(2)}`;}).join(' ')}`);
