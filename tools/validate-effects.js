const fs=require('fs'), path=require('path');
const base=path.join(__dirname,'..','shared','presets')+path.sep;
eval(fs.readFileSync(base+'tech-presets.js','utf8'));
eval(fs.readFileSync(base+'mod-presets.js','utf8'));
eval(fs.readFileSync(base+'card-effects.js','utf8'));
let bad=0;
const chk=(label,presets,impl)=>{
  const pn=presets.map(p=>p.name), inames=Object.keys(impl);
  const missing=pn.filter(n=>!impl[n]), extra=inames.filter(n=>!pn.includes(n));
  console.log(label+': '+pn.length+' presets, '+inames.length+' implemented');
  if(missing.length){bad++;console.log('   MISSING effects: '+missing.join(', '));}
  if(extra.length){bad++;console.log('   ORPHAN effects (no preset): '+extra.join(', '));}
  // a card with mechanical prose must have at least one behaviour key
  presets.forEach(p=>{
    const hasText=[p.onbuild,p.passive,p.onactivate].some(Boolean);
    const e=impl[p.name]||{};
    const hasBehaviour=e.onPlay||e.activate||e.passive||e.placement||e.deployable;
    if(hasText&&!hasBehaviour){bad++;console.log('   NO BEHAVIOUR: '+p.name);}
  });
};
chk('TECH',TECH_PRESETS,CARD_EFFECTS.tech);
chk('MOD ',MOD_PRESETS,CARD_EFFECTS.mod);
// op vocabulary actually used
const ops=new Set();
const walk=v=>{ if(Array.isArray(v))return v.forEach(walk);
  if(v&&typeof v==='object'){ if(typeof v.op==='string')ops.add(v.op); Object.values(v).forEach(walk);} };
walk(CARD_EFFECTS);
console.log('\ndistinct ops used ('+ops.size+'):');
console.log('  '+[...ops].sort().join(' '));
// every op must mean something to the engine: an OPS handler, or a rule the engine looks up by
// name (a static marker such as 'phantomDodge', read with staticOp/playedWith) — otherwise the
// card pays its cost and the engine only logs "not yet simulated"
const engine=fs.readFileSync(path.join(__dirname,'..','shared','engine.js'),'utf8');
const known=o=>new RegExp('OPS\\.'+o+'\\b').test(engine)||engine.includes("'"+o+"'");
const unknownOps=[...ops].filter(o=>!known(o));
if(unknownOps.length){bad++;console.log('   UNIMPLEMENTED ops: '+unknownOps.join(', '));}
// and every trigger a passive listens for must be fired somewhere
const triggers=new Set();
const walkT=v=>{ if(Array.isArray(v))return v.forEach(walkT);
  if(v&&typeof v==='object'){ if(typeof v.trigger==='string')triggers.add(v.trigger); Object.values(v).forEach(walkT);} };
walkT(CARD_EFFECTS);
const unfired=[...triggers].filter(t=>t!=='static'&&!engine.includes("'"+t+"'"));
if(unfired.length){bad++;console.log('   NEVER-FIRED triggers: '+unfired.join(', '));}
console.log(bad?'\nFAILED: '+bad+' problem(s)':'\nOK: every preset has behaviour, no orphans');
process.exit(bad?1:0);
