const fs = require('fs');
const crypto = require('crypto');

const STATE_FILE  = '/tmp/pomo_state.json';
const MINI_DUR    = 600;   // 10 min (3+2+3+2 zones) — PRODUCTION
const BREAK_DUR   = 900;   // 15 min
const DEF_TASK_DUR = 2100; // 35 min if no task times set

function now() { return Math.floor(Date.now() / 1000); }

function nt(t) {
  if (!t || typeof t === 'string') return { text: String(t||'').replace(/<[^>]*>/g,'').slice(0,200), minutes: 0 };
  return { text: String(t.text||'').replace(/<[^>]*>/g,'').slice(0,200), minutes: Number(t.minutes)||0 };
}

function normBlock(b) {
  return {
    label: String(b.label||'').replace(/<[^>]*>/g,'').slice(0,200),
    tasks: (Array.isArray(b.tasks) ? b.tasks : []).slice(0,5).map(nt),
  };
}

// Returns array of {text, seconds} for each task that has a time set,
// or a single entry with DEF_TASK_DUR if none have times.
function getTaskSlots(block) {
  const timed = (block.tasks||[]).filter(t => t.text.trim() && Number(t.minutes) > 0);
  if (timed.length > 0) return timed.map(t => ({ text: t.text, seconds: t.minutes * 60 }));
  // Fall back: all named tasks share DEF_TASK_DUR as one slot
  const named = (block.tasks||[]).filter(t => t.text.trim());
  if (named.length > 0) return [{ text: named.map(t=>t.text).join(' + '), seconds: DEF_TASK_DUR }];
  return [{ text: '', seconds: DEF_TASK_DUR }];
}

function freshBlocks() {
  return [
    { label: 'Block 1', tasks: [{ text:'', minutes:0 }, { text:'', minutes:0 }] },
    { label: 'Block 2', tasks: [{ text:'', minutes:0 }, { text:'', minutes:0 }] },
    { label: 'Block 3', tasks: [{ text:'', minutes:0 }, { text:'', minutes:0 }] },
  ];
}

function defaultState() {
  return {
    phase:'idle', activeBlock:0, activeTaskSlot:0,
    secondsLeft:0, elapsed:0,
    completedBlocks:[], serverTime:now(), running:false, paused:false,
    miniLoop:[true,true,true],
    blocks: freshBlocks(),
    log:[],
  };
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
      if (s && s.phase) {
        if (Array.isArray(s.blocks)) s.blocks = s.blocks.map(normBlock);
        if (s.activeTaskSlot == null) s.activeTaskSlot = 0;
        return s;
      }
    }
  } catch(e) {}
  return defaultState();
}

function writeState(s) {
  s.serverTime = now();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch(e) {}
}

function getToken() { return process.env.OWNER_TOKEN || 'default-dev-token'; }

function checkOwner(req) {
  const sent = (req.headers['x-owner-token']||'').trim();
  const real = getToken();
  if (!sent || sent.length !== real.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real)); } catch(e) { return false; }
}

function advanceState(s) {
  if (!s.running || s.paused) return s;
  const n = now();
  let elapsed = Math.max(0, n - (s.serverTime||n));
  s.serverTime = n;
  while (elapsed > 0 && s.running && !s.paused) {
    const step = Math.min(elapsed, s.secondsLeft);
    s.secondsLeft -= step; s.elapsed += step; elapsed -= step;
    if (s.secondsLeft <= 0) s = nextPhase(s);
  }
  return s;
}

function nextPhase(s) {
  const block = s.blocks[s.activeBlock] || { tasks:[] };
  const slots  = getTaskSlots(block);

  if (s.phase === 'mini') {
    // Start first task slot
    s.phase = 'task'; s.activeTaskSlot = 0;
    s.secondsLeft = slots[0].seconds; s.elapsed = 0;

  } else if (s.phase === 'task') {
    const nextSlot = (s.activeTaskSlot||0) + 1;
    if (nextSlot < slots.length) {
      // Advance to next task slot
      s.activeTaskSlot = nextSlot;
      s.secondsLeft = slots[nextSlot].seconds; s.elapsed = 0;
    } else {
      // All task slots done → break
      s.log = (s.log||[]).concat({
        blockLabel: block.label,
        tasks: block.tasks.filter(t => t.text && t.text.trim()),
        completedAt: now(),
      });
      s.completedBlocks = (s.completedBlocks||[]).concat(s.activeBlock);
      s.phase = 'break'; s.secondsLeft = BREAK_DUR; s.elapsed = 0; s.activeTaskSlot = 0;
    }

  } else if (s.phase === 'break') {
    s.phase = 'idle'; s.running = false; s.paused = false;
    s.secondsLeft = 0; s.elapsed = 0; s.activeTaskSlot = 0;
    if (s.activeBlock < s.blocks.length - 1) s.activeBlock++;
  }
  return s;
}

module.exports = function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query||{}).action || 'get';
  const owner  = checkOwner(req);

  if (req.method === 'GET') {
    if (action === 'setup') return res.status(200).json({ ownerToken: getToken() });
    let s = advanceState(readState());
    writeState(s);
    // Include task slots for current block so client can display them
    const block = s.blocks[s.activeBlock] || { tasks:[] };
    return res.status(200).json({
      ...s, isOwner: owner,
      taskSlots: getTaskSlots(block),
      ...(owner ? { ownerToken: getToken() } : {}),
    });
  }

  if (req.method === 'POST') {
    if (!owner) return res.status(403).json({ error:'Forbidden' });
    const body = req.body || {};
    let s = advanceState(readState());

    switch (action) {
      case 'start': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : s.activeBlock;
        s.activeBlock = bi; s.activeTaskSlot = 0;
        const useMini = s.miniLoop[bi] !== false;
        if (useMini) {
          s.phase = 'mini'; s.secondsLeft = MINI_DUR;
        } else {
          const slots = getTaskSlots(s.blocks[bi]);
          s.phase = 'task'; s.secondsLeft = slots[0].seconds;
        }
        s.elapsed = 0; s.running = true; s.paused = false;
        break;
      }
      case 'pause':
        if (s.running && !s.paused) s.paused = true;
        break;
      case 'resume':
        if (s.running && s.paused) { s.paused = false; s.serverTime = now(); }
        break;
      case 'stop':
        s.phase='idle'; s.running=false; s.paused=false;
        s.secondsLeft=0; s.elapsed=0; s.activeTaskSlot=0;
        // Don't advance activeBlock on stop — let user choose which block to start next
        break;
      case 'skip_mini':
        if (s.phase === 'mini') {
          const slots = getTaskSlots(s.blocks[s.activeBlock]);
          s.phase = 'task'; s.activeTaskSlot = 0;
          s.secondsLeft = slots[0].seconds; s.elapsed = 0;
        }
        break;
      case 'skip_task':
        if (s.phase === 'task') s = nextPhase(s);
        break;
      case 'reset': {
        const log = s.log || [];
        s = defaultState(); s.log = log;
        break;
      }
      case 'update_block': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : 0;
        if (!s.blocks[bi]) break;
        if (body.label != null) s.blocks[bi].label = String(body.label).replace(/<[^>]*>/g,'').slice(0,200);
        if (body.tasks != null) s.blocks[bi].tasks = (Array.isArray(body.tasks)?body.tasks:[]).slice(0,5).map(nt);
        if (body.miniLoop != null) s.miniLoop[bi] = !!body.miniLoop;
        break;
      }
      case 'toggle_mini': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : 0;
        s.miniLoop[bi] = !(s.miniLoop[bi] !== false);
        break;
      }
      case 'clear_log':
        s.log = [];
        break;
      default:
        return res.status(400).json({ error:'Unknown action' });
    }

    writeState(s);
    const block = s.blocks[s.activeBlock] || { tasks:[] };
    return res.status(200).json({
      ...s, isOwner:true, ownerToken:getToken(),
      taskSlots: getTaskSlots(block),
    });
  }

  return res.status(405).json({ error:'Method not allowed' });
};
