/* =========================
   CA Dashboard — Firebase RTDB (Compat)
   Fixes: (1) editTask handler, (2) recurring duplicates re-entrancy
   ========================= */

/* ---------- Utilities ---------- */
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const $ = (sel, root=document) => root.querySelector(sel);
const fmtMoney = n => (Number(n||0)).toLocaleString('en-IN',{maximumFractionDigits:2});
const todayStr = () => new Date().toISOString().slice(0,10);
const yymm = (dstr) => (dstr||'').slice(0,7);
function fmtDateDDMMYYYY(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function addDays(n){ const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function lastDayOfMonth(y,m){ return new Date(y, m+1, 0).getDate(); }
function makeDateYMD(y,m,day){ const max=lastDayOfMonth(y,m); const d=Math.min(day,max); return new Date(y,m,d).toISOString().slice(0,10); }
function prioRank(p){ return ({High:1, Medium:2, Low:3}[p]||9); }
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]))}

/* ---------- Firebase Config (your real keys) ---------- */
const firebaseConfig = {
  apiKey:        "AIzaSyCQ1rOpKAjinpAPF3iiMLKEkV22TxHp1bU",
  authDomain:    "insight-dashboard-1408.firebaseapp.com",
  databaseURL:   "https://insight-dashboard-1408-default-rtdb.firebaseio.com",
  projectId:     "insight-dashboard-1408",
  storageBucket: "insight-dashboard-1408.appspot.com",
  messagingSenderId: "432670525535",
  appId:         "1:432670525535:web:63e82941c0e4935ea8f3ea"
};
if (typeof firebase === 'undefined') {
  console.error('Firebase SDK not loaded. Ensure compat scripts are before script.js.');
}
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const rtdb = firebase.database();

/* ---------- Workspace (fixed) ---------- */
const WORKSPACE = 'insight-dashboard-1408';
const tasksRef = rtdb.ref(`workspaces/${WORKSPACE}/tasks`);
const skipsRef = rtdb.ref(`workspaces/${WORKSPACE}/skips`);

/* ---------- App State ---------- */
let tasks = [];
let skips = [];
let selectedIds = new Set();
let isListening = false;

/* ---------- Realtime listeners ---------- */
function startRealtime(){
  if (isListening) return;
  isListening = true;

  skipsRef.on('value', snap => {
    const obj = snap.val() || {};
    const arr = Object.values(obj);
    skips = arr.map(s => ({ id: s.id || `${s.recurringId}_${s.period}`, recurringId: s.recurringId, period: s.period }));
    render();
  });

  tasksRef.on('value', async snap => {
    const obj = snap.val() || {};
    tasks = Object.values(obj);
    try { await ensureRecurringInstances(); }
    catch (e) { console.error('ensureRecurringInstances failed:', e); }
    render();
  }, err => {
    console.error('RTDB listener error:', err?.message || err);
  });
}
function teardownRealtime(){
  if (!isListening) return;
  isListening = false;
  tasksRef.off(); skipsRef.off();
  tasks=[]; skips=[]; selectedIds.clear();
  render();
}

/* ---------- Skip helpers ---------- */
function isSkipped(recurringId, period){
  return !!skips.find(s => s.recurringId === recurringId && s.period === period);
}
async function addSkip(recurringId, period){
  if (!recurringId || !period || isSkipped(recurringId, period)) return;
  const id = `${recurringId}_${period}`;
  await skipsRef.child(id).set({ id, recurringId, period, createdAt: Date.now() }).catch(e => alert('Write failed (skips): ' + e.message));
}
async function removeSkipsForSeries(recurringId){
  const toRemove = skips.filter(s => s.recurringId === recurringId);
  for (const s of toRemove) { await skipsRef.child(s.id).remove().catch(()=>{}); }
}

/* ---------- Recurring generation (duplicate-proof) ---------- */
// 🔧 FIX: prevent re-entrancy and batch writes so the 'value' listener
// doesn’t re-trigger mid-generation and create multiples.
const HORIZON_MONTHS = 6;
let isGenerating = false;

async function ensureRecurringInstances() {
  if (isGenerating) return;           // guard against re-entrancy
  isGenerating = true;

  try {
    const now = new Date();

    // 1) Gather templates (recur && no period)
    const templates = tasks.filter(t => t.recur && !t.period);

    // 2) Build a set of existing recurring keys (rid|YYYY-MM) from current snapshot
    const existingKeys = new Set(
      tasks
        .filter(t => t.period && t.recurringId)
        .map(t => `${t.recurringId}|${t.period}`)
    );

    // 3) Prepare a single atomic multi-path update
    const updates = {};

    for (const tpl of templates) {
      // derive or patch recurringId + recurDay on the template itself
      const rid = tpl.recurringId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()));
      // if template has a deadline, start from its month; else use current date
      let startY, startM;
      if (tpl.deadline && /^\d{4}-\d{2}-\d{2}$/.test(tpl.deadline)) {
        const [y, m] = tpl.deadline.split('-').map(Number);
        startY = y; startM = m - 1;                   // JS months are 0-based
      } else {
        startY = now.getFullYear(); startM = now.getMonth();
      }
      // day-of-month to use for each instance
      const recurDay = tpl.recurDay || (tpl.deadline ? Number(tpl.deadline.slice(8,10)) : now.getDate());

      // If template missing fields, patch them in the same batch
      if (!tpl.recurringId || tpl.recurDay !== recurDay) {
        updates[`workspaces/${WORKSPACE}/tasks/${tpl.id}/recurringId`] = rid;
        updates[`workspaces/${WORKSPACE}/tasks/${tpl.id}/recurDay`]    = recurDay;
        tpl.recurringId = rid; tpl.recurDay = recurDay; // keep local in sync
      }

      // 4) Generate exactly HORIZON_MONTHS periods, starting at the template month
      for (let i = 0; i < HORIZON_MONTHS; i++) {
        const y = startY + Math.floor((startM + i) / 12);
        const m = (startM + i) % 12;
        const period = `${y}-${String(m+1).padStart(2, '0')}`;
        const key = `${rid}|${period}`;

        // Skip if we already have one, or this month was explicitly skipped
        if (existingKeys.has(key) || isSkipped(rid, period)) continue;

        // Deterministic instance id (prevents duplicates from concurrent writers)
        const id = `${rid}_${period}`;
        const deadline = makeDateYMD(y, m, recurDay);

        updates[`workspaces/${WORKSPACE}/tasks/${id}`] = {
          id,
          client: tpl.client,
          title: tpl.title,
          priority: tpl.priority,
          assignee: tpl.assignee,
          status: 'Not Started',
          fee: Number(tpl.fee || 0),
          advance: 0,
          invoiceStatus: 'Not Raised',
          notes: tpl.notes || '',
          recur: true,
          recurDay,
          recurringId: rid,
          deadline,
          createdAt: Date.now(),
          period
        };

        // So if ensureRecurringInstances() is called again before the DB round-trip,
        // we still won’t enqueue the same period twice.
        existingKeys.add(key);
      }
    }

    // 5) Apply all writes at once → triggers a single 'value' refresh
    if (Object.keys(updates).length) {
      await rtdb.ref().update(updates);
    }
  } finally {
    isGenerating = false;
  }
}

/* ---------- Rendering ---------- */
function render(){
  const tbody = $('#taskTbody'); if (!tbody) return;

  const q  = ($('#searchInput')?.value || '').trim().toLowerCase();
  const pf = $('#priorityFilter')?.value || '';
  const sfRaw = $('#statusFilter').value;
const sf = sfRaw ? new Set(sfRaw.split('|')) : null;
  const af = $('#assigneeFilter')?.value || '';
  const mf = $('#monthFilter')?.value || '';

  let filtered = tasks.filter(t => !(t.recur && !t.period));

  filtered = filtered.filter(t => {
    const matchQ = !q || [t.client,t.title,t.assignee,(t.notes||'')].some(x => String(x||'').toLowerCase().includes(q));
    const matchP = !pf || t.priority === pf;
    const matchS = !sf || sf.has(t.status);
    const matchA = !af || t.assignee === af;
    const matchM = !mf || yymm(t.deadline) === mf;
    return matchQ && matchP && matchS && matchA && matchM;
  });

  const sortBy = $('#sortBy')?.value || 'deadline';
  const dir = ($('#sortDir')?.value || 'asc') === 'asc' ? 1 : -1;
  filtered.sort((a,b)=>{
    if (sortBy==='deadline')  return (a.deadline||'').localeCompare(b.deadline||'') * dir;
    if (sortBy==='createdAt') return ((a.createdAt||0)-(b.createdAt||0)) * dir;
    if (sortBy==='priority')  return (prioRank(a.priority)-prioRank(b.priority)) * dir;
    if (sortBy==='status')    return (a.status||'').localeCompare(b.status||'') * dir;
    if (sortBy==='fee')       return ((a.fee||0)-(b.fee||0)) * dir;
    return 0;
  });

  const assignees = [...new Set(tasks.filter(t=>!(t.recur && !t.period)).map(t=>t.assignee).filter(Boolean))].sort();
  const afSel = $('#assigneeFilter');
  if (afSel) {
    const cur = afSel.value;
    afSel.innerHTML = '<option value="">In-Charge: All</option>' + assignees.map(a=>`<option ${a===cur?'selected':''}>${esc(a)}</option>`).join('');
  }

  const months = [...new Set(tasks.filter(t=>t.deadline).map(t=>yymm(t.deadline)))].sort();
  const mfSel = $('#monthFilter');
  if (mfSel){
    const cur = mfSel.value;
    mfSel.innerHTML = '<option value="">Month: All</option>' + months.map(m=>`<option ${m===cur?'selected':''} value="${m}">${formatMonthLabel(m)}</option>`).join('');
  }

  tbody.innerHTML = filtered.map(rowHtml).join('');

  for (const cb of $$('#taskTbody input[type="checkbox"].row-select')) {
    cb.checked = selectedIds.has(cb.dataset.id);
  }

  const now = todayStr();
  const visible = tasks.filter(t=>!(t.recur && !t.period));
  const total = visible.length;
  const pending = visible.filter(t=>t.status!=='Completed').length;
  const overdue = visible.filter(t=>t.status!=='Completed' && t.deadline && t.deadline < now).length;
  const sumFee = visible.reduce((s,t)=>s+Number(t.fee||0),0);
  const sumAdv = visible.reduce((s,t)=>s+Number(t.advance||0),0);
  const sumOut = sumFee - sumAdv;
  $('#kpiTotal') && ($('#kpiTotal').textContent = total);
  $('#kpiPending') && ($('#kpiPending').textContent = pending);
  $('#kpiOverdue') && ($('#kpiOverdue').textContent = overdue);
  $('#kpiFee') && ($('#kpiFee').textContent = fmtMoney(sumFee));
  $('#kpiAdv') && ($('#kpiAdv').textContent = fmtMoney(sumAdv));
  $('#kpiOut') && ($('#kpiOut').textContent = fmtMoney(sumOut));

  updateSelectAllState();
}
function formatMonthLabel(m){
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo-1, 1).toLocaleString('en-IN',{month:'short', year:'numeric'});
}
function rowHtml(t){
  const out = (Number(t.fee||0) - Number(t.advance||0));
  const overdue = t.deadline && t.deadline < todayStr() && t.status !== 'Completed';
  const recBadge = t.recur ? ' <span class="badge recurring" title="Recurring monthly">Monthly</span>' : '';
  return `<tr class="row" data-id="${esc(t.id)}">
    <td><input type="checkbox" class="row-select" data-id="${esc(t.id)}" onchange="toggleSelect('${esc(t.id)}', this.checked)"></td>
    <td title="${esc(t.notes||'')}"><strong>${esc(t.client)}</strong></td>
    <td>${esc(t.title)}${recBadge}</td>
    <td><span class="badge priority ${esc((t.priority||'').toLowerCase())}">${esc(t.priority||'')}</span></td>
    <td>${esc(t.assignee||'')}</td>
    <td>
      <select class="status" onchange="changeStatus('${esc(t.id)}', this.value)">
        ${['Not Started','In Progress','Waiting Client','On Hold','Completed'].map(s=>`<option ${s===t.status?'selected':''}>${s}</option>`).join('')}
      </select>
    </td>
    <td class="${overdue?'overdue':''}">${fmtDateDDMMYYYY(t.deadline)||''}</td>
    <td class="money">₹ ${fmtMoney(t.fee||0)}</td>
    <td class="money">₹ ${fmtMoney(t.advance||0)}</td>
    <td class="money">₹ ${fmtMoney(out)}</td>
    <td>
  <select class="status" onchange="changeInvoiceStatus('${t.id}', this.value)">
    ${['Not Raised','Sent','Paid','Partially Paid'].map(s=>`<option ${s===(t.invoiceStatus||'Not Raised')?'selected':''}>${s}</option>`).join('')}
  </select>
</td>
    <td>
      <button class="btn ghost" onclick="editTask('${esc(t.id)}')">Edit</button>
      
    </td>
  </tr>`;
}

/* ---------- Selection & Bulk ---------- */
function toggleSelect(id, checked){ checked ? selectedIds.add(id) : selectedIds.delete(id); updateSelectAllState(); }
function updateSelectAllState(){
  const rows = $$('#taskTbody tr');
  const ids = new Set(rows.map(r=>r.dataset.id));
  const allChecked = rows.length>0 && [...ids].every(id=>selectedIds.has(id));
  const selAll = $('#selectAll'); if (selAll) selAll.checked = allChecked;
}
window.toggleSelect = toggleSelect;

/* ---------- CRUD ---------- */
async function changeStatus(id, val){
  if (!id) return;
  await tasksRef.child(id).update({ status: val }).catch(e => alert('Update failed: '+e.message));
}
window.changeStatus = changeStatus;

async function delTask(id){
  const t = tasks.find(x=>x.id===id); if(!t) return;
  if (t.recur && !t.period && t.recurringId){
    if(!confirm('Delete this recurring template and all its instances?')) return;
    await tasksRef.child(id).remove().catch(e=>alert('Delete failed: '+e.message));
    const inst = tasks.filter(x=>x.recurringId===t.recurringId && x.period);
    for (const it of inst) await tasksRef.child(it.id).remove().catch(()=>{});
    await removeSkipsForSeries(t.recurringId);
  } else if (t.recur && t.period && t.recurringId){
    if(!confirm('Delete this recurring instance for this month?')) return;
    await addSkip(t.recurringId, t.period);
    await tasksRef.child(id).remove().catch(e=>alert('Delete failed: '+e.message));
  } else {
    if(!confirm('Delete this task?')) return;
    await tasksRef.child(id).remove().catch(e=>alert('Delete failed: '+e.message));
  }
  selectedIds.delete(id);
}
window.delTask = delTask;

/* ---------- Modal handling (fallback to prompts if no modal) ---------- */
const modal = $('#taskModal');
const taskForm = $('#taskForm');
function openModal(title){
  if (modal) {
    $('#taskModalTitle') && ($('#taskModalTitle').textContent = title||'Task');
    modal.classList.add('active');
    setTimeout(()=>$('#fClient')?.focus(), 20);
  }
}
function closeModal(){ modal && modal.classList.remove('active'); }

$('#addTaskBtn') && ($('#addTaskBtn').onclick = async ()=>{
  if (taskForm) {
    taskForm.reset(); delete taskForm.dataset.editId;
    $('#fDeadline') && ($('#fDeadline').value = todayStr());
    openModal('New Task');
  } else {
    try { await createTaskByPrompt(); }
    catch(e){ alert('Add failed: ' + (e?.message||e)); }
  }
});
$('#cancelBtn') && ($('#cancelBtn').onclick = closeModal);
modal && (modal.addEventListener('click', e=>{ if(e.target===modal) closeModal(); }));

// 🔧 FIX: implement editTask() (rows call it)
function editTask(id){
  const t = tasks.find(x=>x.id===id); if(!t) return;
  if (taskForm){
    openModal('Edit Task');
    taskForm.dataset.editId = id;
    $('#fClient').value = t.client||'';
    $('#fTitle').value = t.title||'';
    $('#fPriority').value = t.priority||'Medium';
    $('#fAssignee').value = t.assignee||'';
    $('#fStatus').value = t.status||'In Progress';
    $('#fDeadline').value = t.deadline||'';
    $('#fFee').value = t.fee||0;
    $('#fAdvance').value = t.advance||0;
    $('#fInvoiceStatus').value = t.invoiceStatus||'';
    $('#fNotes').value = t.notes||'';
    $('#fRecurring') && ($('#fRecurring').checked = !!t.recur && !t.period);
  } else {
    editTaskByPrompt(t);
  }
}

async function changeInvoiceStatus(id, val){
  if (!id) return;
  try{
    await tasksRef.child(id).update({ invoiceStatus: val });
    // RTDB 'value' listener will refresh the row after write
  } catch(e){
    alert('Update failed (invoice status): ' + (e?.message || e));
  }
}
window.changeInvoiceStatus = changeInvoiceStatus;

if (taskForm) {
  taskForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const editId = taskForm.dataset.editId;
    const existing = editId ? tasks.find(x=>x.id===editId) : null;

    const isRecurringTemplate = $('#fRecurring')?.checked;
    const dval = $('#fDeadline')?.value || '';

    const data = {
      client: $('#fClient')?.value.trim() || '',
      title: $('#fTitle')?.value.trim() || '',
      priority: $('#fPriority')?.value || 'Medium',
      assignee: $('#fAssignee')?.value.trim() || '',
      status: $('#fStatus')?.value || 'In Progress',
      deadline: dval,
      fee: Number($('#fFee')?.value || 0),
      advance: Number($('#fAdvance')?.value || 0),
      invoiceStatus: $('#fInvoiceStatus')?.value || '',
      notes: $('#fNotes')?.value?.trim() || ''
    };
    if (data.advance > data.fee){ alert('Advance cannot exceed total fee.'); return; }

    try{
      if (existing){
        const wasTemplate = !!existing.recur && !existing.period;
        if (wasTemplate){
          const recurDay = dval ? Number(dval.slice(8,10)) : new Date().getDate();
          const updates = { ...data, recur:true, recurDay, recurringId: existing.recurringId || (crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random())) };
          await tasksRef.child(existing.id).update(updates);
          const today = todayStr();
          const fut = tasks.filter(t=> t.recurringId===updates.recurringId && t.period && t.deadline>=today);
          for (const it of fut) await tasksRef.child(it.id).remove();
          await ensureRecurringInstances();
        } else {
          await tasksRef.child(existing.id).update(data);
        }
      } else {
        if (isRecurringTemplate){
          const recurDay = dval ? Number(dval.slice(8,10)) : new Date().getDate();
          const rid = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
          const id = rid;
          const tpl = { id, createdAt: Date.now(), ...data, recur:true, recurDay, recurringId: rid, period: null };
          await tasksRef.child(id).set(tpl);
          await ensureRecurringInstances();
        } else {
          const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
          await tasksRef.child(id).set({ id, createdAt: Date.now(), ...data });
        }
      }
    } catch(e){
      alert('Save failed: ' + e.message);
    }

    closeModal();
  });
}

/* ---------- Prompt-based create/edit (if no modal exists) ---------- */
async function createTaskByPrompt(){
  const client = prompt('Client?'); if (client==null) return;
  const title = prompt('Task title?'); if (title==null) return;
  const priority = prompt('Priority (High/Medium/Low)?','Medium') || 'Medium';
  const assignee = prompt('In-Charge?') || '';
  const status = prompt('Status? (Not Started/In Progress/Waiting Client/On Hold/Completed)','In Progress') || 'In Progress';
  const deadline = prompt('Deadline (YYYY-MM-DD)?', todayStr()) || '';
  const fee = Number(prompt('Fee?','0')||0);
  const advance = Number(prompt('Advance?','0')||0);
  const invoiceDate = prompt('Invoice Date (YYYY-MM-DD)?','') || '';
  const notes = prompt('Notes?','') || '';
  const id = crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random());
  await tasksRef.child(id).set({ id, client, title, priority, assignee, status, deadline, fee, advance, invoiceDate, notes, createdAt: Date.now() });
}

async function editTaskByPrompt(t){
  const client = prompt('Client?', t.client||''); if (client==null) return;
  const title = prompt('Task title?', t.title||''); if (title==null) return;
  const priority = prompt('Priority (High/Medium/Low)?', t.priority||'Medium') || 'Medium';
  const assignee = prompt('In-Charge?', t.assignee||'') || '';
  const status = prompt('Status?', t.status||'In Progress') || 'In Progress';
  const deadline = prompt('Deadline (YYYY-MM-DD)?', t.deadline||todayStr()) || '';
  const fee = Number(prompt('Fee?', String(t.fee||0))||0);
  const advance = Number(prompt('Advance?', String(t.advance||0))||0);
  const invoiceDate = prompt('Invoice Date (YYYY-MM-DD)?', t.invoiceDate||'') || '';
  const notes = prompt('Notes?', t.notes||'') || '';
  await tasksRef.child(t.id).update({ client, title, priority, assignee, status, deadline, fee, advance, invoiceDate, notes });
}

/* ---------- Filters, select-all, bulk, export ---------- */
;['searchInput','priorityFilter','assigneeFilter','monthFilter','sortBy','sortDir']
.forEach(id=> document.getElementById(id).addEventListener('input', render));
// statusFilter is now driven via custom UI; we’ll call render() after Apply/Done.

// ===== Status Multi-select (checkbox dropdown) =====
const STATUS_OPTIONS = ['Not Started','In Progress','Waiting Client','On Hold','Completed'];

(function initStatusMulti(){
  const hidden = $('#statusFilter');
  const btn = $('#statusMultiBtn');
  const menu = $('#statusMultiMenu');
  const applyBtn = $('#statusApplyBtn');
  const clearBtn = $('#statusClearBtn');

  // state kept as a Set
  const sel = new Set();

  function updateButtonLabel(){
    if(sel.size===0){ btn.textContent = 'Status: All'; return; }
    if(sel.size===STATUS_OPTIONS.length){ btn.textContent = 'Status: All'; return; }
    btn.textContent = `Status: ${sel.size} selected`;
  }
  function syncHidden(){
    hidden.value = (sel.size===0 || sel.size===STATUS_OPTIONS.length) ? '' : [...sel].join('|');
  }
  function open(){ menu.hidden = false; document.addEventListener('click', onDocClick, { once:false }); }
  function close(){ menu.hidden = true; document.removeEventListener('click', onDocClick, { once:false }); }
  function onDocClick(e){
    if(menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  }

  // Toggle menu
  btn.addEventListener('click', ()=>{
    if(menu.hidden) open(); else close();
  });

  // Checkbox changes (do not auto-close; allow multiple picks)
  menu.querySelectorAll('input[type="checkbox"]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      cb.checked ? sel.add(cb.value) : sel.delete(cb.value);
    });
  });

  // Apply/Done: persist to hidden + render + close
  applyBtn.addEventListener('click', ()=>{
    syncHidden(); updateButtonLabel(); close(); render();
  });

  // Clear: uncheck all, clear set, apply & close
  clearBtn.addEventListener('click', ()=>{
    sel.clear();
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb=> cb.checked=false);
    syncHidden(); updateButtonLabel(); close(); render();
  });

  // (Optional) initialize from hidden (if you want to preserve previous state)
  if(hidden.value){
    hidden.value.split('|').forEach(v=>{
      if(STATUS_OPTIONS.includes(v)) sel.add(v);
    });
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb=> cb.checked = sel.has(cb.value));
  }
  updateButtonLabel();
})();

$('#selectAll') && ($('#selectAll').addEventListener('change', (e)=>{
  const rows = $$('#taskTbody tr');
  const ids = rows.map(r=>r.dataset.id);
  if (e.target.checked) ids.forEach(id=>selectedIds.add(id));
  else ids.forEach(id=>selectedIds.delete(id));
  render();
}));

$('#bulkDeleteBtn') && ($('#bulkDeleteBtn').addEventListener('click', async ()=>{
  const visibleRows = $$('#taskTbody tr');
  const visibleIds = new Set(visibleRows.map(r=>r.dataset.id));
  const toActOn = [...selectedIds].filter(id=>visibleIds.has(id));
  if (toActOn.length===0){ alert('Select at least one task (visible).'); return; }
  const pass = prompt('Enter password to delete selected tasks:');
  if (pass !== '14Dec@1998'){ alert('Incorrect password.'); return; }
  if (!confirm(`Delete ${toActOn.length} task(s)? This cannot be undone.`)) return;

  const toDelete = new Set(toActOn);
  for (const t of tasks){
    if (!toDelete.has(t.id)) continue;
    if (t.recur && !t.period && t.recurringId){
      const inst = tasks.filter(x=>x.recurringId===t.recurringId && x.period);
      inst.forEach(i=>toDelete.add(i.id));
      await removeSkipsForSeries(t.recurringId);
    } else if (t.recur && t.period && t.recurringId){
      await addSkip(t.recurringId, t.period);
    }
  }
  for (const id of toDelete){ await tasksRef.child(id).remove().catch(()=>{}); }
  selectedIds.clear();
}));

$('#exportCsvBtn') && ($('#exportCsvBtn').addEventListener('click', ()=>{
  const rows = [[
    'Client','Task','Priority','In-Charge','Status','Deadline','Fee','Advance','Outstanding','Invoice Status','Notes','Recurring','Recurring Day','Recurring ID','Period'
  ]];
  tasks.forEach(t=>{
    if (t.recur && !t.period) return;
    const out = (Number(t.fee||0) - Number(t.advance||0));
    rows.push([
      t.client,t.title,t.priority,t.assignee,t.status,fmtDateDDMMYYYY(t.deadline),t.fee,t.advance,out,t.invoiceStatus,(t.notes||'').replace(/\n/g,' '),
      t.recur? 'Yes':'No', t.recurDay||'', t.recurringId||'', t.period||''
    ]);
  });
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `CA-Tasks-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
}));

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', ()=>{
  render();        // initial render
  startRealtime(); // attach RTDB listeners
});
