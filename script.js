import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.HQ_CONFIG;
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const CHAR_IMG = "assets/character.webp";
const MAP_IMG = "assets/map.webp";

/* ---------- session ---------- */
function loadSession(){ try{ return JSON.parse(localStorage.getItem('hq_session')||'null'); }catch(e){ return null; } }
function saveSession(s){ localStorage.setItem('hq_session', JSON.stringify(s)); }
function clearSession(){ localStorage.removeItem('hq_session'); }

let SESSION = loadSession(); // {id, role, display_name}
let ROLE = SESSION ? SESSION.role : null;

/* ---------- in-memory caches (rebuilt from Supabase on load / realtime) ---------- */
let CONFIG = { phases:[], checklist:[], negativeConditions:[], rewards:[] };
let STATE = { currentTic:1, phaseIndex:0, phaseStartTic:1, phaseStartDate:null, pendingSpin:false, gameComplete:false };
let DAY_LOGS = {};       // tic -> {checks, comment, flagged, flagReason, setback, completedAt}
let HISTORY = [];
let EARNED = [];
let PENDING_REPORTS = []; // phase_reports where accepted = false

let TAB = 'map';
let MODAL = null;
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
      gameComplete: qs.data.game_complete
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

const PATH_POINTS = [
  [12,90],[22,80],[14,64],[26,52],[20,38],[34,30],[30,16],
  [46,10],[58,18],[52,32],[64,40],[58,54],[70,60],[78,48],
  [84,34],[76,20],[86,10],[92,22],[88,38],[80,52],[86,66],[74,76],[58,80],[44,88],[28,92]
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
  if(PENDING_REPORTS.length || STATE.gameComplete) return;
  const tic = STATE.currentTic;
  await upsertDayLog(tic, {completedAt: todayISO()});
  await insertHistory({type:'complete', tic, amount:null, reason:null, comment:null});

  const phase = currentPhase();
  if(tic >= phase.endTic){
    await openPhaseCompletion(phase);
  } else {
    await updateQuestState({currentTic: tic+1});
  }
  render();
  scheduleRefresh();
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
  await updateQuestState({currentTic: phase.endTic, pendingSpin: CONFIG.rewards.length>0});
}

async function resolveSpin(rewardIdx){
  const reward = CONFIG.rewards[rewardIdx];
  const usableAtTic = reward.timing==='immediate' ? STATE.currentTic : STATE.currentTic + (parseInt(reward.timingValue)||0);
  await supabase.from('earned_rewards').insert({
    reward_id: reward.id, name: reward.name, description: reward.desc,
    won_at_tic: STATE.currentTic, used:false, usable_at_tic: usableAtTic
  });
  await updateQuestState({pendingSpin:false});
  render();
  scheduleRefresh();
}

async function acceptPhaseReport(report){
  await supabase.from('phase_reports').update({accepted:true}).eq('id', report.id);
  const bounds = phaseBoundaries();
  const newPhaseIndex = STATE.phaseIndex + 1;
  if(newPhaseIndex >= bounds.length){
    await updateQuestState({gameComplete:true});
  } else {
    const newStart = STATE.currentTic + 1;
    await updateQuestState({phaseIndex:newPhaseIndex, phaseStartTic:newStart, currentTic:newStart, phaseStartDate: todayISO()});
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
  await supabase.from('quest_state').update({
    current_tic:1, phase_index:0, phase_start_tic:1, phase_start_date: todayISO(),
    pending_spin:false, game_complete:false
  }).eq('id',1);
  await fetchAll();
}

/* ============================================================
   LOGIN
   ============================================================ */
async function attemptLogin(name, password){
  LOGIN_ERROR='';
  const {data, error} = await supabase.rpc('login', {p_name:name, p_password:password});
  if(error || !data || data.length===0){
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
      <button class="role-pill" id="logoutBtn">${SESSION.display_name} · ${ROLE==='coach'?'Coach':'Player'} (log out)</button>
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
  const frac = Math.min(1, (STATE.currentTic-1)/Math.max(1,totalTics()-1));
  const [cx,cy] = pointAtFraction(frac);
  const dots = bounds.map(b=>{
    const f = Math.min(1,(b.endTic-1)/Math.max(1,totalTics()-1));
    const [x,y] = pointAtFraction(f);
    const done = STATE.phaseIndex > bounds.indexOf(b) || STATE.gameComplete;
    return `<div class="phase-dot ${done?'done':''}" style="left:${x}%; top:${y}%;" title="${b.name}"></div>`;
  }).join('');
  return `
  <div class="map-wrap">
    <img class="map-img" src="${MAP_IMG}" alt="quest map">
    <div class="map-overlay">
      ${dots}
      <img class="char-token" src="${CHAR_IMG}" style="left:${cx}%; top:${cy}%;">
      <div class="tic-banner">DAY ${STATE.currentTic}/${totalTics()}</div>
    </div>
  </div>
  <div class="panel">
    <h2>PHASES</h2>
    ${bounds.map((b,i)=>{
      const cls = i<STATE.phaseIndex ? 'done' : (i===STATE.phaseIndex? 'current':'upcoming');
      return `<div class="phase-chip ${cls}"><span>${b.name}</span><span>${cls==='done'?'✔ done':(cls==='current'? 'in progress':'tics '+b.startTic+'–'+b.endTic)}</span></div>`;
    }).join('')}
    <div class="progress-track"><div class="progress-fill" style="width:${frac*100}%"></div></div>
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
  if(ready.length===0 && used.length===0){ html += `<div class="empty-state">No rewards yet — they're won at the end of each phase.</div>`; }
  ready.forEach(r=>{
    const canUse = STATE.currentTic >= r.usableAtTic;
    html += `<div class="reward-card">
      <h4>${r.name}</h4><p>${r.desc||''}</p>
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
    <p class="hint">Each phase is a stretch of tics. When Spouse B passes the last tic in a phase, a reward spin triggers and a report card is generated for your review.</p>`;
  CONFIG.phases.forEach(p=>{
    html += `<div class="list-row">
      <input type="text" class="grow" data-phase-name="${p.id}" value="${p.name}">
      <input type="number" style="width:70px" data-phase-tics="${p.id}" value="${p.tics}" min="1">
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
      <span style="font-size:11px">every</span>
      <input type="number" style="width:55px" data-cl-repeat="${c.id}" value="${c.repeatDays}" min="1">
      <span style="font-size:11px">d</span>
      <button class="x-btn" data-remove-cl="${c.id}">×</button>
    </div>`;
  });
  html += `<div class="btn-row"><button class="btn ghost" id="addClBtn">+ Add checklist item</button></div></div>`;

  html += `<div class="panel"><h2>SET-BACK CONDITIONS</h2>
    <p class="hint">Reasons you can flag a day for, and how many tics it costs Spouse B.</p>`;
  CONFIG.negativeConditions.forEach(c=>{
    html += `<div class="list-row">
      <input type="text" class="grow" data-cond-label="${c.id}" value="${c.label}">
      <span style="font-size:11px">−</span>
      <input type="number" style="width:55px" data-cond-setback="${c.id}" value="${c.setback}" min="1">
      <button class="x-btn" data-remove-cond="${c.id}">×</button>
    </div>`;
  });
  html += `<div class="btn-row"><button class="btn ghost" id="addCondBtn">+ Add condition</button></div></div>`;

  html += `<div class="panel"><h2>REWARDS POOL</h2>
    <p class="hint">One of these is randomly won on every phase completion. "Delay" means Spouse B must wait that many extra tics before using it.</p>`;
  CONFIG.rewards.forEach(r=>{
    html += `<div class="list-row" style="flex-wrap:wrap">
      <input type="text" class="grow" data-rw-name="${r.id}" value="${r.name}" placeholder="Reward name">
      <button class="x-btn" data-remove-rw="${r.id}">×</button>
      <textarea style="width:100%" rows="1" data-rw-desc="${r.id}" placeholder="Description">${r.desc||''}</textarea>
      <select data-rw-timing="${r.id}" style="width:130px">
        <option value="immediate" ${r.timing==='immediate'?'selected':''}>Immediate</option>
        <option value="delay" ${r.timing==='delay'?'selected':''}>Delay (tics)</option>
      </select>
      ${r.timing==='delay'? `<input type="number" style="width:70px" data-rw-value="${r.id}" value="${r.timingValue||0}" min="0">`:''}
    </div>`;
  });
  html += `<div class="btn-row"><button class="btn ghost" id="addRwBtn">+ Add reward</button></div></div>`;

  html += `<div class="panel"><h2>RESET</h2>
    <p class="hint">Clears all progress, history, and earned rewards. Phases/checklist/rewards setup stays as-is.</p>
    <div class="btn-row"><button class="btn brick" id="resetBtn">Reset progress</button></div></div>`;

  return html;
}

function renderModal(){
  if(PENDING_REPORTS.length===0) return '';
  const report = PENDING_REPORTS[0];

  if(STATE.pendingSpin){
    return `<div class="modal-bg"><div class="modal" style="text-align:center">
      <h2 class="pixel" style="font-size:13px">PHASE COMPLETE!</h2>
      <p class="hint">Spin to reveal Spouse B's reward.</p>
      <div class="slot"><div class="slot-box"><div class="slot-text" id="slotText">???</div></div></div>
      <div class="btn-row" style="justify-content:center"><button class="btn gold" id="spinBtn" ${CONFIG.rewards.length===0?'disabled':''}>🎰 Spin</button></div>
      ${CONFIG.rewards.length===0?'<p class="hint">No rewards configured yet — add some in Setup, or Spouse A can skip ahead via the report card once it appears.</p>':''}
    </div></div>`;
  }

  const earnedThisPhase = EARNED.filter(e=> e.wonAtTic>=report.startTic && e.wonAtTic<=report.endTic);
  return `<div class="modal-bg"><div class="modal">
    <h2 class="pixel" style="font-size:12px">${report.phaseName} REPORT CARD</h2>
    <img src="${CHAR_IMG}" style="width:80px; display:block; margin:0 auto 10px;">
    <div class="report-stat"><span>Tics covered</span><b>${report.startTic} – ${report.endTic}</b></div>
    <div class="report-stat"><span>Real days elapsed</span><b>${daysBetween(report.startDate,report.endDate)}</b></div>
    <div class="report-stat"><span>Set-backs incurred</span><b>${report.setbackCount}</b></div>
    <div class="report-stat"><span>Rewards earned</span><b>${earnedThisPhase.map(e=>e.name).join(', ')||'—'}</b></div>
    <p class="hint" style="margin-top:12px">${ROLE==='coach' ? 'Review and accept to unlock the next phase for Spouse B.' : 'Waiting on Spouse A to review and accept this report.'}</p>
    ${ROLE==='coach' ? `<div class="btn-row"><button class="btn gold" id="acceptReportBtn">Accept & continue</button></div>` : ''}
  </div></div>`;
}

function renderLogin(){
  return `
  <div class="header">
    <div class="title pixel">QUEST TRACKER</div>
    <div class="subtitle">A two-player habit quest</div>
  </div>
  <div class="panel" style="text-align:center">
    <h2>LOG IN</h2>
    <label class="field-label">Name</label>
    <input type="text" id="loginName" placeholder="Your name">
    <label class="field-label">Password</label>
    <input type="password" id="loginPassword" placeholder="namebirthday">
    <div class="btn-row" style="justify-content:center"><button class="btn gold" id="loginBtn">Log in</button></div>
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

  const addRwBtn = document.getElementById('addRwBtn'); if(addRwBtn) addRwBtn.onclick = addReward;
  root.querySelectorAll('[data-rw-name]').forEach(i=> i.onblur=()=>updateReward(i.dataset.rwName,'name',i.value));
  root.querySelectorAll('[data-rw-desc]').forEach(i=> i.onblur=()=>updateReward(i.dataset.rwDesc,'desc',i.value));
  root.querySelectorAll('[data-rw-timing]').forEach(i=> i.onchange=()=>updateReward(i.dataset.rwTiming,'timing',i.value));
  root.querySelectorAll('[data-rw-value]').forEach(i=> i.onblur=()=>updateReward(i.dataset.rwValue,'timingValue',i.value));
  root.querySelectorAll('[data-remove-rw]').forEach(b=> b.onclick=()=>removeReward(b.dataset.removeRw));

  const resetBtn = document.getElementById('resetBtn');
  if(resetBtn) resetBtn.onclick = ()=>{ if(confirm('Reset all progress for both of you? This cannot be undone.')) resetQuest(); };

  const spinBtn = document.getElementById('spinBtn');
  if(spinBtn) spinBtn.onclick = ()=>{
    spinBtn.disabled = true;
    const names = CONFIG.rewards.map(r=>r.name);
    const slotText = document.getElementById('slotText');
    let count=0;
    const finalIdx = Math.floor(Math.random()*CONFIG.rewards.length);
    const interval = setInterval(()=>{
      slotText.textContent = names[Math.floor(Math.random()*names.length)];
      count++;
      if(count>18){
        clearInterval(interval);
        slotText.textContent = names[finalIdx];
        setTimeout(()=> resolveSpin(finalIdx), 900);
      }
    }, 90);
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
