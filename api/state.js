const fs = require('fs');
const crypto = require('crypto');

const STATE_FILE = '/tmp/pomo_state.json';
const MINI_DUR = 600, TASK_DUR = 2100, BREAK_DUR = 900;

function defaultState() {
  return {
    phase: 'idle', activeBlock: 0, secondsLeft: 0, elapsed: 0,
    completedBlocks: [], serverTime: now(), running: false,
    miniLoop: [true, true, true],
    blocks: [
      { label: 'Block 1 — Main Work', tasks: ['', ''] },
      { label: 'Block 2 — Preview',   tasks: ['', ''] },
      { label: 'Block 3 — Preview',   tasks: ['', ''] },
    ],
  };
}

function now() { return Math.floor(Date.now() / 1000); }

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
  if (process.env.OWNER_TOKEN) return process.env.OWNER_TOKEN;
  return 'default-dev-token';
}

function isOwner(req) {
  const sent = (req.headers['x-owner-token'] || '').trim();
  const real = getToken();
  if (!sent || sent.length !== real.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real));
  } catch(e) { return false; }
}

function advanceState(s) {
  if (!s.running) return s;
  const n = now();
  let elapsed = Math.max(0, n - (s.serverTime || n));
  s.serverTime = n;
  while (elapsed > 0 && s.running) {
    const step = Math.min(elapsed, s.secondsLeft);
    s.secondsLeft -= step;
    s.elapsed += step;
    elapsed -= step;
    if (s.secondsLeft <= 0) s = nextPhase(s);
  }
  return s;
}

function nextPhase(s) {
  if (s.phase === 'mini') {
    s.phase = 'task'; s.secondsLeft = TASK_DUR; s.elapsed = 0;
  } else if (s.phase === 'task') {
    s.completedBlocks = (s.completedBlocks || []).concat(s.activeBlock);
    s.phase = 'break'; s.secondsLeft = BREAK_DUR; s.elapsed = 0;
  } else if (s.phase === 'break') {
    s.phase = 'idle'; s.running = false;
    s.secondsLeft = 0; s.elapsed = 0;
    if (s.activeBlock < 2) s.activeBlock++;
  }
  return s;
}

function clean(str) {
  return String(str || '').replace(/<[^>]*>/g, '').slice(0, 200);
}

module.exports = function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const action = (req.query || {}).action || 'get';
  const owner = isOwner(req);

  if (req.method === 'GET') {
    if (action === 'setup') {
      return res.status(200).json({ ownerToken: getToken() });
    }
    // action === 'get'
    let s = advanceState(readState());
    writeState(s);
    const out = Object.assign({}, s, { isOwner: owner });
    if (owner) out.ownerToken = getToken();
    return res.status(200).json(out);
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
        s.secondsLeft = useMini ? MINI_DUR : TASK_DUR;
        s.elapsed = 0; s.running = true;
        break;
      }
      case 'skip_mini':
        if (s.phase === 'mini') { s.phase = 'task'; s.secondsLeft = TASK_DUR; s.elapsed = 0; }
        break;
      case 'reset': {
        const blocks = s.blocks; const miniLoop = s.miniLoop;
        s = defaultState(); s.blocks = blocks; s.miniLoop = miniLoop;
        break;
      }
      case 'update_block': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : 0;
        if (body.label != null) s.blocks[bi].label = clean(body.label);
        if (body.tasks != null) s.blocks[bi].tasks = body.tasks.slice(0,3).map(clean);
        if (body.miniLoop != null) s.miniLoop[bi] = !!body.miniLoop;
        break;
      }
      case 'toggle_mini': {
        const bi = body.blockIndex != null ? Number(body.blockIndex) : 0;
        s.miniLoop[bi] = !(s.miniLoop[bi] !== false);
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    writeState(s);
    const out = Object.assign({}, s, { isOwner: true, ownerToken: getToken() });
    return res.status(200).json(out);
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
