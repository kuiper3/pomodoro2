const fs = require('fs');
const crypto = require('crypto');

const STATE_FILE = '/tmp/pomo_state.json';
const MINI_DUR = 600, BREAK_DUR = 900;

function now() { return Math.floor(Date.now() / 1000); }

function getTaskDur(block) {
  const sum = (block.tasks || []).reduce((a, t) => a + (Number(t.minutes) || 0), 0);
  return sum > 0 ? sum * 60 : 2100;
}

function defaultState() {
  return {
    phase: 'idle', activeBlock: 0, secondsLeft: 0, elapsed: 0,
    completedBlocks: [], serverTime: now(), running: false, paused: false,
    miniLoop: [true, true, true],
    blocks: [
      { label: 'Block 1 — Main Work', tasks: [{ text: '', minutes: 0 }, { text: '', minutes: 0 }] },
      { label: 'Block 2 — Preview',   tasks: [{ text: '', minutes: 0 }, { text: '', minutes: 0 }] },
      { label: 'Block 3 — Preview',   tasks: [{ text: '', minutes: 0 }, { text: '', minutes: 0 }] },
    ],
    log: [],
  };
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s && s.phase) return s;
    }
  } catch(e) {}
  return defaultState();
}

function writeState(s) {
  s.serverTime = now();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch(e) {}
}

function getToken() {
  return process.env.OWNER_TOKEN || 'default-dev-token';
}

function checkOwner(req) {
  const sent = (req.headers['x-owner-token'] || '').trim();
  const real = getToken();
  if (!sent || sent.length !== real.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real)); } catch(e) { return false; }
}

function advanceState(s) {
  if (!s.running || s.paused) return s;
  const n = now();
  let elapsed = Math.max(0, n - (s.serverTime || n));
  s.serverTime = n;
  while (elapsed > 0 && s.running && !s.paused) {
    const step = Math.min(elapsed, s.secondsLeft);
    s.secondsLeft -= step;
    s.elapsed += step;
    elapsed -= step;
    if (s.secondsLeft <= 0) s = nextPhase(s);
  }
  return s;
}

function nextPhase(s) {
  const taskDur = getTaskDur(s.blocks[s.activeBlock] || { tasks: [] });
  if (s.phase === 'mini') {
    s.phase = 'task'; s.secondsLeft = taskDur; s.elapsed = 0;
  } else if (s.phase === 'task') {
    const block = s.blocks[s.activeBlock];
    s.log = (s.log || []).concat({
      blockLabel: block.label,
      tasks: (block.tasks || []).filter(t => t.text && t.text.trim()),
      completedAt: now(),
    });
    s.completedBlocks = (s.completedBlocks || []).concat(s.activeBlock);
    s.phase = 'break'; s.secondsLeft = BREAK_DUR; s.elapsed = 0;
  } else if (s.phase === 'break') {
    s.phase = 'idle'; s.running = false; s.paused = false;
    s.secondsLeft = 0; s.elapsed = 0;
    if (s.activeBlock < s.blocks.length - 1) s.activeBlock++;
  }
  return s;
}

function clean(v) { return String(v || '').replace(/<[^>]*>/g, '').slice(0, 200); }

function normalizeTasks(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 3).map(t => {
    if (typeof t === 'string') return { text: clean(t), minutes: 0 };
    return { text: clean(t.text || ''), minutes: Number(t.minutes) || 0 };
  });
}

module.exports = function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query || {}).action || 'get';
  const owner = checkOwner(req);

  if (req.method === 'GET') {
    if (action === 'setup') return res.status(200).json({ ownerToken: getToken() });
    let s = advanceState(readState());
    writeState(s);
    return res.status(200).json(Object.assign({}, s, { isOwner: owner, ...(owner ? { ownerToken: getToken() } : {}) }));
  }

  if (req.method === 'POST') {
    if (!owner) return res.status(403).json({ error: 'Forbidden' });
    const body = req.body || {};
    let s = advanceState(readState());

    switch (action) {
      case 'start': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : s.activeBlock;
        s.activeBlock = bi;
        const useMini = s.miniLoop[bi] !== false;
        s.phase = useMini ? 'mini' : 'task';
        s.secondsLeft = useMini ? MINI_DUR : getTaskDur(s.blocks[bi]);
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
        s.phase = 'idle'; s.running = false; s.paused = false;
        s.secondsLeft = 0; s.elapsed = 0;
        break;
      case 'skip_mini':
        if (s.phase === 'mini') {
          s.phase = 'task'; s.secondsLeft = getTaskDur(s.blocks[s.activeBlock]); s.elapsed = 0;
        }
        break;
      case 'reset': {
        const { blocks, miniLoop, log } = s;
        s = defaultState(); s.blocks = blocks; s.miniLoop = miniLoop; s.log = log || [];
        break;
      }
      case 'update_block': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : 0;
        if (!s.blocks[bi]) break;
        if (body.label != null) s.blocks[bi].label = clean(body.label);
        if (body.tasks != null) s.blocks[bi].tasks = normalizeTasks(body.tasks);
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
        return res.status(400).json({ error: 'Unknown action' });
    }

    writeState(s);
    return res.status(200).json(Object.assign({}, s, { isOwner: true, ownerToken: getToken() }));
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
