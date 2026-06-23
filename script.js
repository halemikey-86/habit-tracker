import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.HQ_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const CHAR_IMG = "assets/MichaelChar.png";
const MAP_IMG = "assets/Phase 1 Map.png";
const NODE_ACTIVE = "assets/Node Active.png";
const NODE_INACTIVE = "assets/Node Not Active.png";
const NODE_ALERT = "assets/Node Alert.png";

const REWARD_POOL = [
  { key:'movie',  name:'Movie night',             icon:'🎬', glyph:'FILM' },
  { key:'cuddle', name:'Cuddling',                icon:'💕', glyph:'HUG'  },
  { key:'free',   name:'Free Time',               icon:'⏰', glyph:'TIME' },
  { key:'love',   name:'Love Making',             icon:'❤️', glyph:'LOVE' },
  { key:'dinner', name:'Dinner of Your Choice',   icon:'🍽️', glyph:'FOOD' },
];

/* ---------- session ---------- */
function loadSession(){ try{ return JSON.parse(localStorage.getItem('hq_session')||'null'); }catch(e){ return null; } }
function saveSession(s){ localStorage.setItem('hq_session', JSON.stringify(s)); }
function clearSession(){ localStorage.removeItem('hq_session'); }

let SESSION = loadSession(); // {id, role, display_name}
let ROLE = SESSION ? SESSION.role : null;

/* ---------- in-memory caches (rebuilt from Supabase on load / realtime) ---------- */
let CONFIG = { phases:[], checklist:[], negativeConditions:[], rewards:[] };
let STATE = { currentTic:1, phaseIndex:0, phaseStartTic:1, phaseStartDate:null, pendingSpin:false, gameComplete:false, rewardTics:[] };
let DAY_LOGS = {};       // tic -> {checks, comment, flagged, flagReason, setback, completedAt}
let HISTORY = [];
let EARNED = [];
let PENDING_REPORTS = []; // phase_reports where accepted = false

let TAB = 'map';
let PENDING_REWARD_PICK = null; // { tic } — Mario picker after landing on a reward node
let LOGIN_ERROR = '';
let LOADING = true;

function uid(){ return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2,9); }
function todayISO(){ return new Date().toISOString(); }
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function daysBetween(a,b){ return Math.max(0, Math.round((new Date(b)-new Date(a))/86400000)); }

/* ============================================================
   DATA LOADING
   ============================================================ */
async function fetchAll(){
  const [qs, ph, cl, cond, rw, logs, hist, earned, reports] = await Promise.all([
    supabase.from('quest_state').select('*').eq('id',1).single(),
    supabase.from('phases').select('*').order('order_index'),
    supabase.from('checklist_items').select('*'),
    supabase.from('conditions').select('*'),
    supabase.from('rewards').select('*'),
    supabase.from('day_logs').select('*'),
    supabase.from('history').select('*').order('at',{ascending:true}),
    supabase.from('earned_rewards').select('*'),
    supabase.from('phase_reports').select('*').eq('accepted', false)
  ]);

  if(qs.data){
    STATE = {
      currentTic: qs.data.current_tic,
      phaseIndex: qs.data.phase_index,
      phaseStartTic: qs.data.phase_start_tic,
      phaseStartDate: qs.data.phase_start_date,
      pendingSpin: qs.data.pending_spin,
      gameComplete: qs.data.game_complete,
      rewardTics: Array.isArray(qs.data.reward_tics) ? qs.data.reward_tics : []
    };
  }
  CONFIG.phases = (ph.data||[]).map(p=>({id:p.id, name:p.name, tics:p.tics, orderIndex:p.order_index}));
  CONFIG.checklist = (cl.data||[]).map(c=>({id:c.id, label:c.label, repeatDays:c.repeat_days}));
  CONFIG.negativeConditions = (cond.data||[]).map(c=>({id:c.id, label:c.label, setback:c.setback}));
  CONFIG.rewards = (rw.data||[]).map(r=>({id:r.id, name:r.name, desc:r.description, timing:r.timing, timingValue:r.timing_value}));

  DAY_LOGS = {};
  (logs.data||[]).forEach(l=>{
    DAY_LOGS[l.tic] = {checks:l.checks||{}, comment:l.comment||'', flagged:l.flagged, flagReason:l.flag_reason||'', setback:l.setback||0, completedAt:l.completed_at};
  });

  HISTORY = (hist.data||[]).map(h=>({id:h.id, type:h.type, tic:h.tic, amount:h.amount, reason:h.reason, comment:h.comment, at:h.at}));
  EARNED = (earned.data||[]).map(e=>({id:e.id, rewardId:e.reward_id, name:e.name, desc:e.description, wonAtTic:e.won_at_tic, wonAt:e.won_at, used:e.used, usedAt:e.used_at, usableAtTic:e.usable_at_tic}));
  PENDING_REPORTS = (reports.data||[]).map(r=>({id:r.id, phaseId:r.phase_id, phaseName:r.phase_name, startTic:r.start_tic, endTic:r.end_tic, startDate:r.start_date, endDate:r.end_date, setbackCount:r.setback_count, accepted:r.accepted}));

  await ensurePhaseRewardTics();
  LOADING = false;
  render();
}

let refreshTimer = null;
function scheduleRefresh(){
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(fetchAll, 250);
}

function subscribeRealtime(){
  const tables = ['quest_state','phases','checklist_items','conditions','rewards','day_logs','history','earned_rewards','phase_reports'];
  const channel = supabase.channel('hq-sync');
  tables.forEach(t=> channel.on('postgres_changes', {event:'*', schema:'public', table:t}, scheduleRefresh));
  channel.subscribe();
}

/* ============================================================
   DERIVED HELPERS
   ============================================================ */
function phaseBoundaries(){
  let acc=0; const bounds=[];
  for(const p of CONFIG.phases){ acc+=p.tics; bounds.push({...p, endTic:acc, startTic:acc-p.tics+1}); }
  return bounds;
}
function currentPhase(){ return phaseBoundaries()[STATE.phaseIndex] || null; }
function totalTics(){ return CONFIG.phases.reduce((s,p)=>s+p.tics,0) || 365; }
function isDueOnTic(item, tic){ const r = Math.max(1, parseInt(item.repeatDays)||1); return ((tic-1) % r) === 0; }
function dueItemsForTic(tic){ return CONFIG.checklist.filter(c=>isDueOnTic(c,tic)); }
function getLog(tic){ return DAY_LOGS[tic] || {checks:{}, comment:'', flagged:false, flagReason:'', setback:0, completedAt:null}; }

// Waypoints along the trail — red circle (start) at bottom, blue circle (finish) top-left.
const PATH_POINTS = [
  [57.0,94.5],[60.4,94.8],[63.9,94.3],[67.4,93.8],[71.1,93.4],[74.7,92.9],[78.3,92.4],
  [80.0,85.0],[77.3,80.5],[74.3,76.1],[70.7,71.8],[65.6,63.6],[65.6,59.3],[66.7,55.0],[71.0,53.1],[75.1,50.8],[77.9,46.8],[78.2,42.3],[77.4,38.2],[75.0,33.9],[70.9,30.8],[66.5,29.0],
  [28.3,31.1],[28.3,35.4],[28.4,39.5],[28.3,43.8],[28.0,48.2],[27.7,52.7],[26.7,57.1],[25.3,61.4],[24.7,66.0],[24.7,70.3],
  [27.6,72.9],[31.3,72.2],[35.1,71.4],[38.9,70.7],[42.7,70.0],[46.8,69.4],[51.1,70.3],[55.4,71.5],[54.8,77.3],[50.6,80.3],[48.2,83.8],[49.3,88.2],[52.4,92.8],
  [28.3,26.4],[28.3,22.2],[28.3,17.9],[28.4,13.6],[28.4,4.9]
];
function pathLength(){ let len=0; for(let i=1;i<PATH_POINTS.length;i++){ const [x1,y1]=PATH_POINTS[i-1],[x2,y2]=PATH_POINTS[i]; len+=Math.hypot(x2-x1,y2-y1); } return len; }
function pointAtFraction(frac){
  frac = Math.max(0, Math.min(1, frac));
  const total = pathLength(); let target = total*frac, acc=0;
  for(let i=1;i<PATH_POINTS.length;i++){
    const [x1,y1]=PATH_POINTS[i-1],[x2,y2]=PATH_POINTS[i];
    const seg = Math.hypot(x2-x1,y2-y1);
    if(acc+seg >= target || i===PATH_POINTS.length-1){ const t = seg===0?0:(target-acc)/seg; return [x1+(x2-x1)*t, y1+(y2-y1)*t]; }
    acc += seg;
  }
  return PATH_POINTS[PATH_POINTS.length-1];
}
function ticPathFraction(tic, phaseStartTic, phaseTics){
  if(phaseTics <= 1) return 0;
  return (tic - phaseStartTic) / (phaseTics - 1);
}
function nodeAssetForTic(tic){
  if(tic === STATE.currentTic) return NODE_ACTIVE;
  if(getLog(tic).flagged) return NODE_ALERT;
  return NODE_INACTIVE;
}

function earnedTicSet(){ return new Set(EARNED.map(e=>e.wonAtTic)); }
function hasRewardOnTic(tic){
  return STATE.rewardTics.includes(tic) && !earnedTicSet().has(tic);
}
function generateRewardTics(startTic, endTic, fromTic){
  const candidates=[];
  for(let t=fromTic; t<=endTic; t++) candidates.push(t);
  if(!candidates.length) return [];
  const pct = 0.14 + Math.random() * 0.08;
  let count = Math.max(1, Math.round(candidates.length * pct));
  count = Math.min(count, Math.max(1, Math.floor(candidates.length * 0.3)));
  const shuffled = [...candidates].sort(()=>Math.random()-0.5);
  return shuffled.slice(0, count).sort((a,b)=>a-b);
}
async function ensurePhaseRewardTics(){
  const phase = currentPhase();
  if(!phase || STATE.gameComplete) return;
  const earned = earnedTicSet();
  const inPhase = STATE.rewardTics.filter(t=>t>=phase.startTic && t<=phase.endTic && !earned.has(t));
  if(inPhase.length) {
    if(inPhase.length !== STATE.rewardTics.length) await persistRewardTics(inPhase);
    return;
  }
  const fresh = generateRewardTics(phase.startTic, phase.endTic, Math.max(phase.startTic, STATE.currentTic));
  await persistRewardTics(fresh);
}
async function persistRewardTics(tics){
  STATE.rewardTics = tics;
  await supabase.from('quest_state').update({reward_tics:tics, updated_at:todayISO()}).eq('id',1);
}
function rewardByName(name){
  return REWARD_POOL.find(r=>r.name===name) || CONFIG.rewards.find(r=>r.name===name);
}

/* ============================================================
   MUTATIONS
   ============================================================ */
async function upsertDayLog(tic, patch){
  const cur = getLog(tic);
  const merged = {...cur, ...patch};
  DAY_LOGS[tic] = merged; // optimistic
  await supabase.from('day_logs').upsert({
    tic, checks: merged.checks, comment: merged.comment, flagged: merged.flagged,
    flag_reason: merged.flagReason, setback: merged.setback, completed_at: merged.completedAt
  });
}
async function updateQuestState(patch){
  const dbPatch = {};
  if('currentTic' in patch) dbPatch.current_tic = patch.currentTic;
  if('phaseIndex' in patch) dbPatch.phase_index = patch.phaseIndex;
  if('phaseStartTic' in patch) dbPatch.phase_start_tic = patch.phaseStartTic;
  if('phaseStartDate' in patch) dbPatch.phase_start_date = patch.phaseStartDate;
  if('pendingSpin' in patch) dbPatch.pending_spin = patch.pendingSpin;
  if('gameComplete' in patch) dbPatch.game_complete = patch.gameComplete;
  dbPatch.updated_at = todayISO();
  STATE = {...STATE, ...patch}; // optimistic
  await supabase.from('quest_state').update(dbPatch).eq('id',1);
}
async function insertHistory(row){
  HISTORY.push({...row, id:uid(), at: todayISO()});
  await supabase.from('history').insert({type:row.type, tic:row.tic, amount:row.amount, reason:row.reason, comment:row.comment});
}

async function toggleCheck(tic, itemId){
  const log = getLog(tic);
  const checks = {...log.checks, [itemId]: !log.checks[itemId]};
  await upsertDayLog(tic, {checks});
  render();
}
async function setComment(tic, text){ await upsertDayLog(tic, {comment:text}); }

async function completeDay(){
  if(PENDING_REPORTS.length || STATE.gameComplete || PENDING_REWARD_PICK) return;
  const tic = STATE.currentTic;
  await upsertDayLog(tic, {completedAt: todayISO()});
  await insertHistory({type:'complete', tic, amount:null, reason:null, comment:null});

  if(hasRewardOnTic(tic)){
    PENDING_REWARD_PICK = {tic};
    render();
    return;
  }
  await advanceAfterDayComplete(tic);
}

async function advanceAfterDayComplete(tic){
  const phase = currentPhase();
  if(tic >= phase.endTic){
    await openPhaseCompletion(phase);
  } else {
    await updateQuestState({currentTic: tic+1});
  }
  render();
  scheduleRefresh();
}

async function awardRandomReward(tic, poolIdx){
  const pick = REWARD_POOL[poolIdx];
  const dbReward = CONFIG.rewards.find(r=>r.name===pick.name);
  await supabase.from('earned_rewards').insert({
    reward_id: dbReward?.id || null,
    name: pick.name,
    description: dbReward?.desc || '',
    won_at_tic: tic,
    used: false,
    usable_at_tic: tic
  });
  const remaining = STATE.rewardTics.filter(t=>t!==tic);
  await persistRewardTics(remaining);
  PENDING_REWARD_PICK = null;
  await advanceAfterDayComplete(tic);
}

async function applyFlag(reasonObj, comment, customSetback){
  const tic = STATE.currentTic;
  const setback = customSetback != null ? customSetback : reasonObj.setback;
  await upsertDayLog(tic, {flagged:true, flagReason:reasonObj.label, comment: comment || getLog(tic).comment, setback});
  const floor = STATE.phaseStartTic;
  const newTic = Math.max(floor, STATE.currentTic - setback);
  await updateQuestState({currentTic:newTic});
  await insertHistory({type:'setback', tic, amount:setback, reason:reasonObj.label, comment});
  render();
  scheduleRefresh();
}

async function addCoachNote(tic, text){
  await upsertDayLog(tic, {comment:text});
  await insertHistory({type:'note', tic, amount:null, reason:null, comment:text});
  render();
  scheduleRefresh();
}

async function openPhaseCompletion(phase){
  const setbackCount = HISTORY.filter(h=>h.type==='setback' && h.tic>=STATE.phaseStartTic && h.tic<=phase.endTic).length;
  await supabase.from('phase_reports').insert({
    phase_id: phase.id, phase_name: phase.name,
    start_tic: STATE.phaseStartTic, end_tic: phase.endTic,
    start_date: STATE.phaseStartDate, end_date: todayISO(),
    setback_count: setbackCount, accepted: false
  });
  await updateQuestState({currentTic: phase.endTic, pendingSpin:false});
}

async function acceptPhaseReport(report){
  await supabase.from('phase_reports').update({accepted:true}).eq('id', report.id);
  const bounds = phaseBoundaries();
  const newPhaseIndex = STATE.phaseIndex + 1;
  if(newPhaseIndex >= bounds.length){
    await updateQuestState({gameComplete:true});
  } else {
    const newStart = STATE.currentTic + 1;
    const nextPhase = bounds[newPhaseIndex];
    const rewardTics = generateRewardTics(nextPhase.startTic, nextPhase.endTic, nextPhase.startTic);
    await updateQuestState({phaseIndex:newPhaseIndex, phaseStartTic:newStart, currentTic:newStart, phaseStartDate: todayISO()});
    await persistRewardTics(rewardTics);
  }
  render();
  scheduleRefresh();
}

async function useReward(id){
  EARNED = EARNED.map(r=> r.id===id? {...r, used:true, usedAt:todayISO()} : r);
  await supabase.from('earned_rewards').update({used:true, used_at:todayISO()}).eq('id', id);
  render();
}

/* ---------- setup CRUD ---------- */
async function addPhase(){ await supabase.from('phases').insert({name:'Phase '+(CONFIG.phases.length+1), tics:30, order_index:CONFIG.phases.length}); scheduleRefresh(); }
async function removePhase(id){ if(CONFIG.phases.length<=1) return; await supabase.from('phases').delete().eq('id',id); scheduleRefresh(); }
async function updatePhase(id, field, val){ const patch = field==='tics' ? {tics:Math.max(1,parseInt(val)||1)} : {name:val}; await supabase.from('phases').update(patch).eq('id',id); scheduleRefresh(); }

async function addChecklistItem(){ await supabase.from('checklist_items').insert({label:'New item', repeat_days:1}); scheduleRefresh(); }
async function removeChecklistItem(id){ await supabase.from('checklist_items').delete().eq('id',id); scheduleRefresh(); }
async function updateChecklistItem(id, field, val){ const patch = field==='repeatDays' ? {repeat_days:Math.max(1,parseInt(val)||1)} : {label:val}; await supabase.from('checklist_items').update(patch).eq('id',id); scheduleRefresh(); }

async function addCondition(){ await supabase.from('conditions').insert({label:'New condition', setback:1}); scheduleRefresh(); }
async function removeCondition(id){ await supabase.from('conditions').delete().eq('id',id); scheduleRefresh(); }
async function updateCondition(id, field, val){ const patch = field==='setback' ? {setback:Math.max(1,parseInt(val)||1)} : {label:val}; await supabase.from('conditions').update(patch).eq('id',id); scheduleRefresh(); }

async function addReward(){ await supabase.from('rewards').insert({name:'New reward', description:'', timing:'immediate', timing_value:0}); scheduleRefresh(); }
async function removeReward(id){ await supabase.from('rewards').delete().eq('id',id); scheduleRefresh(); }
async function updateReward(id, field, val){
  let patch = {};
  if(field==='name') patch.name = val;
  else if(field==='desc') patch.description = val;
  else if(field==='timing') patch.timing = val;
  else if(field==='timingValue') patch.timing_value = Math.max(0, parseInt(val)||0);
  await supabase.from('rewards').update(patch).eq('id',id);
  scheduleRefresh();
}

async function resetQuest(){
  await Promise.all([
    supabase.from('day_logs').delete().not('tic','is',null),
    supabase.from('history').delete().not('id','is',null),
    supabase.from('earned_rewards').delete().not('id','is',null),
    supabase.from('phase_reports').delete().not('id','is',null)
  ]);
  const phase = CONFIG.phases[0];
  const rewardTics = phase ? generateRewardTics(1, phase.tics, 1) : [];
  await supabase.from('quest_state').update({
    current_tic:1, phase_index:0, phase_start_tic:1, phase_start_date: todayISO(),
    pending_spin:false, game_complete:false, reward_tics: rewardTics
  }).eq('id',1);
  PENDING_REWARD_PICK = null;
  await fetchAll();
}

/* ============================================================
   LOGIN
   ============================================================ */
async function attemptLogin(name, password){
  LOGIN_ERROR='';
  if(isConfigPlaceholder()){
    LOGIN_ERROR = 'Supabase is not configured yet. Edit config.js with your Project URL and anon key from Supabase → Project Settings → API.';
    render();
    return;
  }
  const {data, error} = await supabase.rpc('login', {p_name:name, p_password:password});
  if(error){
    LOGIN_ERROR = error.message?.includes('Failed to fetch') || error.message?.includes('fetch')
      ? 'Could not reach Supabase. Check SUPABASE_URL in config.js and that your project is running.'
      : (error.message || 'Login failed.');
    render();
    return;
  }
  if(!data || data.length===0){
    LOGIN_ERROR = 'Name or password not recognized.';
    render();
    return;
  }
  SESSION = data[0];
  ROLE = SESSION.role;
  saveSession(SESSION);
  await fetchAll();
  subscribeRealtime();
}
function logout(){ clearSession(); SESSION=null; ROLE=null; render(); }

/* ============================================================
   RENDERING
   ============================================================ */
function renderHeader(){
  return `
  <div class="header">
    <div class="header-row">
      <div>
        <div class="title pixel">QUEST TRACKER</div>
        <div class="subtitle">Tic ${STATE.currentTic} of ${totalTics()} · ${currentPhase()? currentPhase().name : 'Complete'}</div>
      </div>
      <button class="role-pill" id="logoutBtn" aria-label="Log out">${SESSION.display_name} · ${ROLE==='coach'?'Coach':'Player'}</button>
    </div>
  </div>`;
}

function renderNav(){
  const tabs = ROLE==='coach'
    ? [['map','Map'],['today','Today'],['rewards','Rewards'],['coach','Coach Tools'],['setup','Setup']]
    : [['map','Map'],['today','Today'],['rewards','Rewards']];
  return `<div class="nav">${tabs.map(([k,l])=>`<button data-tab="${k}" class="${TAB===k?'active':''}">${l}</button>`).join('')}</div>`;
}

function renderMap(){
  const bounds = phaseBoundaries();
  const phase = currentPhase();
  const phaseTics = phase ? phase.tics : 1;
  const phaseStart = phase ? phase.startTic : 1;
  const phaseEnd = phase ? phase.endTic : totalTics();
  const ticInPhase = phase ? STATE.currentTic - phaseStart + 1 : STATE.currentTic;
  const phaseFrac = ticPathFraction(STATE.currentTic, phaseStart, phaseTics);

  let nodes = '';
  let charMarkup = '';
  let rewardMarkers = '';
  for(let tic = phaseStart; tic <= phaseEnd; tic++){
    const frac = ticPathFraction(tic, phaseStart, phaseTics);
    const [x,y] = pointAtFraction(frac);
    const isActive = tic === STATE.currentTic;
    const nodeSize = phaseTics > 50 ? 'map-node--sm' : (phaseTics > 25 ? 'map-node--md' : '');
    nodes += `<img class="map-node ${nodeSize}${isActive?' map-node--active':''}" src="${nodeAssetForTic(tic)}" style="left:${x}%; top:${y}%;" alt="tic ${tic}" title="Tic ${tic}">`;
    if(hasRewardOnTic(tic) && tic >= STATE.currentTic){
      rewardMarkers += `<div class="map-reward-marker pixel" style="left:${x}%; top:${y}%;" title="Hidden reward">★</div>`;
    }
    if(isActive){
      charMarkup = `<img class="char-token" src="${CHAR_IMG}" style="left:${x}%; top:${y}%;" alt="your character">`;
    }
  }

  return `
  <div class="map-wrap">
    <img class="map-img" src="${MAP_IMG}" alt="quest map">
    <div class="map-overlay">
      ${nodes}
      ${rewardMarkers}
      ${charMarkup}
      <div class="tic-banner">DAY ${ticInPhase}/${phaseTics}</div>
    </div>
  </div>
  <div class="panel">
    <h2>PHASES</h2>
    ${bounds.map((b,i)=>{
      const cls = i<STATE.phaseIndex ? 'done' : (i===STATE.phaseIndex? 'current':'upcoming');
      return `<div class="phase-chip ${cls}"><span>${b.name}</span><span>${cls==='done'?'✔ done':(cls==='current'? 'in progress':'tics '+b.startTic+'–'+b.endTic)}</span></div>`;
    }).join('')}
    <div class="progress-track"><div class="progress-fill" style="width:${phaseFrac*100}%"></div></div>
  </div>`;
}

function renderToday(){
  if(STATE.gameComplete){
    return `<div class="panel"><h2>QUEST COMPLETE</h2><p>Every phase is done. Spouse A can review the full history in Coach Tools, or reset to start a new quest in Setup.</p></div>`;
  }
  const tic = STATE.currentTic;
  const log = getLog(tic);
  const due = dueItemsForTic(tic);
  let html = `<div class="panel"><h2>TODAY · TIC ${tic}</h2>`;
  if(hasRewardOnTic(tic)){ html += `<div class="reward-banner pixel">★ Hidden reward on this node!</div>`; }
  if(log.flagged){ html += `<div class="flag-banner">⚠ Flagged: ${log.flagReason} (−${log.setback} tics)</div>`; }
  if(due.length===0){
    html += `<div class="empty-state">No checklist items are due today. Spouse A can add some in Setup.</div>`;
  } else {
    html += due.map(item=>`
      <div class="check-item ${log.checks[item.id]?'done':''}">
        <input type="checkbox" data-check="${item.id}" ${log.checks[item.id]?'checked':''}>
        <label>${item.label}</label>
        <span class="freq">${item.repeatDays===1?'daily':'every '+item.repeatDays+'d'}</span>
      </div>`).join('');
  }
  html += `<label class="field-label">Notes for today</label>
    <textarea id="dayComment" rows="2" placeholder="Add a note...">${log.comment||''}</textarea>`;
  html += `<div class="btn-row">
      <button class="btn" id="completeDayBtn" ${PENDING_REPORTS.length?'disabled':''}>Mark day complete & advance</button>
    </div>`;
  if(PENDING_REPORTS.length){ html += `<p class="hint">Phase complete — waiting on Spouse A to review the report card before the next day unlocks.</p>`; }
  html += `</div>`;
  return html;
}

function renderRewards(){
  const ready = EARNED.filter(r=>!r.used);
  const used = EARNED.filter(r=>r.used);
  let html = `<div class="panel"><h2>REWARDS EARNED</h2>`;
  if(ready.length===0 && used.length===0){ html += `<div class="empty-state">No rewards yet — complete days on ★ nodes to win random prizes.</div>`; }
  ready.forEach(r=>{
    const canUse = STATE.currentTic >= r.usableAtTic;
    const pool = rewardByName(r.name);
    html += `<div class="reward-card">
      <h4>${pool?.icon ? pool.icon+' ':''}${r.name}</h4><p>${r.desc||''}</p>
      <span class="reward-status ${canUse?'ready':'waiting'}">${canUse? 'Ready to use' : 'Unlocks at tic '+r.usableAtTic}</span>
      ${canUse? `<div class="btn-row"><button class="btn gold" data-use="${r.id}">Use this reward</button></div>` : ''}
    </div>`;
  });
  used.forEach(r=>{ html += `<div class="reward-card"><h4>${r.name}</h4><p>${r.desc||''}</p><span class="reward-status used">Used ${fmtDate(r.usedAt)}</span></div>`; });
  html += `</div>`;
  return html;
}

function renderCoach(){
  const tic = STATE.currentTic;
  const log = getLog(tic);
  let html = `<div class="panel"><h2>FLAG TODAY (TIC ${tic})</h2>
    <p class="hint">Choose a reason — this will move the character back the configured number of tics.</p>`;
  if(CONFIG.negativeConditions.length===0){
    html += `<div class="empty-state">No conditions set up yet. Add some in Setup.</div>`;
  } else {
    html += `<label class="field-label">Reason</label><select id="flagReason">`+
      CONFIG.negativeConditions.map(c=>`<option value="${c.id}">${c.label} (−${c.setback})</option>`).join('')+`</select>`;
    html += `<label class="field-label">Comment</label><textarea id="flagComment" rows="2" placeholder="What happened?"></textarea>`;
    html += `<div class="btn-row"><button class="btn brick" id="applyFlagBtn" ${PENDING_REPORTS.length?'disabled':''}>Apply flag & move character back</button></div>`;
  }
  html += `</div>`;

  html += `<div class="panel"><h2>LEAVE A NOTE</h2>
    <textarea id="coachNote" rows="2" placeholder="Encouragement, context, anything...">${log.comment||''}</textarea>
    <div class="btn-row"><button class="btn ghost" id="saveNoteBtn">Save note to tic ${tic}</button></div></div>`;

  html += `<div class="panel"><h2>HISTORY</h2>`;
  if(HISTORY.length===0){ html += `<div class="empty-state">No history yet.</div>`; }
  else {
    html += [...HISTORY].reverse().slice(0,25).map(h=>{
      if(h.type==='setback') return `<div class="list-row"><span class="tag">tic ${h.tic}</span><span class="grow">⚠ −${h.amount} · ${h.reason}${h.comment? ' — '+h.comment:''}</span></div>`;
      if(h.type==='complete') return `<div class="list-row"><span class="tag">tic ${h.tic}</span><span class="grow">✔ day completed</span></div>`;
      return `<div class="list-row"><span class="tag">tic ${h.tic}</span><span class="grow">📝 ${h.comment}</span></div>`;
    }).join('');
  }
  html += `</div>`;
  return html;
}

function renderSetup(){
  let html = `<div class="panel"><h2>PHASES / TIERS</h2>
    <p class="hint">Each phase is a stretch of tics. Hidden ★ reward nodes are scattered on the map — completing those days wins a random prize. Phase-end report cards still go to Coach for review.</p>`;
  CONFIG.phases.forEach(p=>{
    html += `<div class="list-row">
      <input type="text" class="grow" data-phase-name="${p.id}" value="${p.name}">
      <input type="number" class="input-num--tics" data-phase-tics="${p.id}" value="${p.tics}" min="1">
      <button class="x-btn" data-remove-phase="${p.id}">×</button>
    </div>`;
  });
  html += `<div class="btn-row"><button class="btn ghost" id="addPhaseBtn">+ Add phase</button></div>
    <p class="hint">Total tics across phases: <b>${totalTics()}</b></p></div>`;

  html += `<div class="panel"><h2>CHECKLIST ITEMS</h2>
    <p class="hint">"Repeat every X days" controls how often an item appears (1 = every day).</p>`;
  CONFIG.checklist.forEach(c=>{
    html += `<div class="list-row">
      <input type="text" class="grow" data-cl-label="${c.id}" value="${c.label}">
      <span class="field-hint">every</span>
      <input type="number" class="input-num--sm" data-cl-repeat="${c.id}" value="${c.repeatDays}" min="1">
      <span class="field-hint">d</span>
      <button class="x-btn" data-remove-cl="${c.id}">×</button>
    </div>`;
  });
  html += `<div class="btn-row"><button class="btn ghost" id="addClBtn">+ Add checklist item</button></div></div>`;

  html += `<div class="panel"><h2>SET-BACK CONDITIONS</h2>
    <p class="hint">Reasons you can flag a day for, and how many tics it costs Spouse B.</p>`;
  CONFIG.negativeConditions.forEach(c=>{
    html += `<div class="list-row">
      <input type="text" class="grow" data-cond-label="${c.id}" value="${c.label}">
      <span class="field-hint">−</span>
      <input type="number" class="input-num--sm" data-cond-setback="${c.id}" value="${c.setback}" min="1">
      <button class="x-btn" data-remove-cond="${c.id}">×</button>
    </div>`;
  });
  html += `<div class="btn-row"><button class="btn ghost" id="addCondBtn">+ Add condition</button></div></div>`;

  html += `<div class="panel"><h2>REWARDS POOL</h2>
    <p class="hint">★ nodes on the map award one of these at random (Mario-style picker) when Spouse B completes that day.</p>
    <div class="reward-pool-grid">`;
  REWARD_POOL.forEach(r=>{
    html += `<div class="reward-pool-item">
      <span class="reward-pool-icon pixel">${r.icon}</span>
      <span class="reward-pool-name">${r.name}</span>
    </div>`;
  });
  html += `</div>
    <p class="hint">~15–22% of remaining phase days get a hidden ★ each phase.</p></div>`;

  html += `<div class="panel"><h2>RESET</h2>
    <p class="hint">Clears all progress, history, and earned rewards. Phases/checklist/rewards setup stays as-is.</p>
    <div class="btn-row"><button class="btn brick" id="resetBtn">Reset progress</button></div></div>`;

  return html;
}

function renderRewardPicker(){
  if(!PENDING_REWARD_PICK) return '';
  const items = REWARD_POOL.map((r,i)=>`
    <div class="mario-item" data-mario-idx="${i}">
      <div class="mario-item-frame">
        <span class="mario-item-icon">${r.icon}</span>
        <span class="mario-item-glyph pixel">${r.glyph}</span>
      </div>
    </div>`).join('');
  return `<div class="modal-bg"><div class="modal modal--center modal--mario">
    <h2 class="pixel modal-title mario-title">ITEM GET!</h2>
    <p class="hint">A reward was hidden on this node...</p>
    <div class="mario-picker-wrap">
      <div class="mario-cursor pixel" id="marioCursor">▼</div>
      <div class="mario-track" id="marioTrack">${items}</div>
    </div>
    <div class="mario-result" id="marioResult" hidden>
      <div class="mario-result-frame">
        <span class="mario-result-icon" id="marioResultIcon"></span>
        <span class="mario-result-glyph pixel" id="marioResultGlyph"></span>
      </div>
      <div class="mario-result-name pixel" id="marioResultName"></div>
    </div>
    <div class="btn-row btn-row--center">
      <button class="btn gold" id="marioStartBtn">Reveal reward</button>
      <button class="btn" id="marioCollectBtn" hidden>Collect!</button>
    </div>
  </div></div>`;
}

function renderModal(){
  if(PENDING_REWARD_PICK) return renderRewardPicker();
  if(PENDING_REPORTS.length===0) return '';
  const report = PENDING_REPORTS[0];

  const earnedThisPhase = EARNED.filter(e=> e.wonAtTic>=report.startTic && e.wonAtTic<=report.endTic);
  return `<div class="modal-bg"><div class="modal">
    <h2 class="pixel modal-title">${report.phaseName} REPORT CARD</h2>
    <img class="modal-char" src="${CHAR_IMG}" alt="">
    <div class="report-stat"><span>Tics covered</span><b>${report.startTic} – ${report.endTic}</b></div>
    <div class="report-stat"><span>Real days elapsed</span><b>${daysBetween(report.startDate,report.endDate)}</b></div>
    <div class="report-stat"><span>Set-backs incurred</span><b>${report.setbackCount}</b></div>
    <div class="report-stat"><span>Rewards earned</span><b>${earnedThisPhase.map(e=>e.name).join(', ')||'—'}</b></div>
    <p class="hint hint--spaced">${ROLE==='coach' ? 'Review and accept to unlock the next phase for Spouse B.' : 'Waiting on Spouse A to review and accept this report.'}</p>
    ${ROLE==='coach' ? `<div class="btn-row"><button class="btn gold" id="acceptReportBtn">Accept & continue</button></div>` : ''}
  </div></div>`;
}

function runMarioRewardPicker(startBtn){
  startBtn.disabled = true;
  const track = document.getElementById('marioTrack');
  const cursor = document.getElementById('marioCursor');
  const result = document.getElementById('marioResult');
  const collectBtn = document.getElementById('marioCollectBtn');
  const items = [...track.querySelectorAll('.mario-item')];
  const finalIdx = Math.floor(Math.random() * REWARD_POOL.length);
  let idx = 0;
  let ticks = 0;
  const maxTicks = (5 + Math.floor(Math.random() * 4)) * items.length + finalIdx;

  function highlight(i){
    items.forEach((el,j)=> el.classList.toggle('mario-item--lit', j===i));
    const item = items[i];
    if(item && cursor){
      const trackRect = track.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      cursor.style.left = (itemRect.left - trackRect.left + itemRect.width/2)+'px';
    }
  }

  function finish(){
    highlight(finalIdx);
    const pick = REWARD_POOL[finalIdx];
    document.getElementById('marioResultIcon').textContent = pick.icon;
    document.getElementById('marioResultGlyph').textContent = pick.glyph;
    document.getElementById('marioResultName').textContent = pick.name;
    result.hidden = false;
    track.classList.add('mario-track--done');
    collectBtn.hidden = false;
    collectBtn.dataset.idx = finalIdx;
    startBtn.hidden = true;
  }

  function step(){
    idx = (idx+1) % items.length;
    highlight(idx);
    ticks++;
    if(ticks >= maxTicks){ finish(); return; }
    const delay = ticks > maxTicks - 6 ? 90 + (ticks - (maxTicks - 6)) * 55 : 80;
    setTimeout(step, delay);
  }

  highlight(0);
  setTimeout(step, 80);
}

function renderLogin(){
  return `
  <div class="header">
    <div class="title pixel">QUEST TRACKER</div>
    <div class="subtitle">A two-player habit quest</div>
  </div>
  <div class="panel panel--center">
    <h2>LOG IN</h2>
    <label class="field-label">Name</label>
    <input type="text" id="loginName" placeholder="Your name">
    <label class="field-label">Password</label>
    <input type="password" id="loginPassword" placeholder="namebirthday">
    <div class="btn-row btn-row--center"><button class="btn gold" id="loginBtn">Log in</button></div>
    ${LOGIN_ERROR? `<div class="error-banner">${LOGIN_ERROR}</div>` : ''}
  </div>`;
}

function render(){
  const root = document.getElementById('root');

  if(!SESSION){
    root.innerHTML = renderLogin();
    document.getElementById('loginBtn').onclick = ()=>{
      const name = document.getElementById('loginName').value.trim();
      const pwd = document.getElementById('loginPassword').value;
      if(name && pwd) attemptLogin(name, pwd);
    };
    return;
  }

  if(LOADING){
    root.innerHTML = `<div class="header"><div class="title pixel">QUEST TRACKER</div></div><div class="panel"><div class="empty-state">Loading...</div></div>`;
    return;
  }

  let body = renderHeader() + renderNav();
  if(TAB==='map') body += renderMap();
  else if(TAB==='today') body += renderToday();
  else if(TAB==='rewards') body += renderRewards();
  else if(TAB==='coach' && ROLE==='coach') body += renderCoach();
  else if(TAB==='setup' && ROLE==='coach') body += renderSetup();
  else { TAB='map'; body = renderHeader()+renderNav()+renderMap(); }

  root.innerHTML = body + renderModal();
  attachEvents();
}

function attachEvents(){
  const root = document.getElementById('root');
  const lo = document.getElementById('logoutBtn');
  if(lo) lo.onclick = ()=>{ if(confirm('Log out?')) logout(); };

  root.querySelectorAll('[data-tab]').forEach(b=> b.onclick = ()=>{ TAB=b.dataset.tab; render(); });
  root.querySelectorAll('[data-check]').forEach(cb=> cb.onchange = ()=> toggleCheck(STATE.currentTic, cb.dataset.check));

  const dc = document.getElementById('dayComment');
  if(dc) dc.onblur = ()=> setComment(STATE.currentTic, dc.value);

  const cdBtn = document.getElementById('completeDayBtn');
  if(cdBtn) cdBtn.onclick = completeDay;

  root.querySelectorAll('[data-use]').forEach(b=> b.onclick = ()=> useReward(b.dataset.use));

  const flagBtn = document.getElementById('applyFlagBtn');
  if(flagBtn) flagBtn.onclick = ()=>{
    const sel = document.getElementById('flagReason');
    const reason = CONFIG.negativeConditions.find(c=>c.id===sel.value);
    const comment = document.getElementById('flagComment').value;
    if(reason) applyFlag(reason, comment);
  };
  const noteBtn = document.getElementById('saveNoteBtn');
  if(noteBtn) noteBtn.onclick = ()=> addCoachNote(STATE.currentTic, document.getElementById('coachNote').value);

  const addPhaseBtn = document.getElementById('addPhaseBtn'); if(addPhaseBtn) addPhaseBtn.onclick = addPhase;
  root.querySelectorAll('[data-phase-name]').forEach(i=> i.onblur=()=>updatePhase(i.dataset.phaseName,'name',i.value));
  root.querySelectorAll('[data-phase-tics]').forEach(i=> i.onblur=()=>updatePhase(i.dataset.phaseTics,'tics',i.value));
  root.querySelectorAll('[data-remove-phase]').forEach(b=> b.onclick=()=>removePhase(b.dataset.removePhase));

  const addClBtn = document.getElementById('addClBtn'); if(addClBtn) addClBtn.onclick = addChecklistItem;
  root.querySelectorAll('[data-cl-label]').forEach(i=> i.onblur=()=>updateChecklistItem(i.dataset.clLabel,'label',i.value));
  root.querySelectorAll('[data-cl-repeat]').forEach(i=> i.onblur=()=>updateChecklistItem(i.dataset.clRepeat,'repeatDays',i.value));
  root.querySelectorAll('[data-remove-cl]').forEach(b=> b.onclick=()=>removeChecklistItem(b.dataset.removeCl));

  const addCondBtn = document.getElementById('addCondBtn'); if(addCondBtn) addCondBtn.onclick = addCondition;
  root.querySelectorAll('[data-cond-label]').forEach(i=> i.onblur=()=>updateCondition(i.dataset.condLabel,'label',i.value));
  root.querySelectorAll('[data-cond-setback]').forEach(i=> i.onblur=()=>updateCondition(i.dataset.condSetback,'setback',i.value));
  root.querySelectorAll('[data-remove-cond]').forEach(b=> b.onclick=()=>removeCondition(b.dataset.removeCond));

  const resetBtn = document.getElementById('resetBtn');
  if(resetBtn) resetBtn.onclick = ()=>{ if(confirm('Reset all progress for both of you? This cannot be undone.')) resetQuest(); };

  const marioStart = document.getElementById('marioStartBtn');
  if(marioStart) marioStart.onclick = ()=> runMarioRewardPicker(marioStart);
  const marioCollect = document.getElementById('marioCollectBtn');
  if(marioCollect) marioCollect.onclick = ()=>{
    if(marioCollect.dataset.idx!=null) awardRandomReward(PENDING_REWARD_PICK.tic, parseInt(marioCollect.dataset.idx,10));
  };
  const acceptBtn = document.getElementById('acceptReportBtn');
  if(acceptBtn) acceptBtn.onclick = ()=> acceptPhaseReport(PENDING_REPORTS[0]);
}

/* ---------- init ---------- */
async function init(){
  render(); // shows login or loading immediately
  if(SESSION){
    await fetchAll();
    subscribeRealtime();
  }
}
init();
