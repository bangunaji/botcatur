/**
 * Chess Analyzer — app.js
 * chess.js (move logic) + Stockfish WASM (engine) via Blob Worker
 */

import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════ */
const UNICODE = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

// Stockfish sources — tried in order
const SF_SOURCES = [
  'stockfish-nnue-16-single.js',
  'node_modules/stockfish/src/stockfish-nnue-16-single.js',
  'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js',
  'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
];

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
let chess        = new Chess();
let flipped      = false;
let selSq        = null;          // selected square
let legalTargets = [];            // legal target squares for selSq
let lastMove     = null;          // {from, to}
let engMove      = null;          // {from, to} engine suggestion highlight
let dragInfo     = null;          // {from, piece}
let stockfish    = null;
let sfReady      = false;
let sfBusy       = false;
let timerTick    = null;
let promoResolve = null;

/* ═══════════════════════════════════════════════════════════
   DOM
═══════════════════════════════════════════════════════════ */
const $  = id => document.getElementById(id);
const board      = $('chessboard');
const fenInput   = $('fen-input');
const btnStart   = $('btn-startpos');
const btnSetFen  = $('btn-setfen');
const btnClear   = $('btn-clear');
const btnFlip    = $('btn-flip');
const btnUndo    = $('btn-undo');
const btnCopyFen = $('btn-copy-fen');
const btnCopyPGN = $('btn-copy-pgn');
const btnCalc    = $('btn-calculate');
const calcLabel  = $('calc-label');
const calcSpinner= $('calc-spinner');
const turnW      = $('turn-white');
const turnB      = $('turn-black');
const cWK        = $('c-wk');
const cWQ        = $('c-wq');
const cBK        = $('c-bk');
const cBQ        = $('c-bq');
const modeShow   = $('mode-show');
const modeMake   = $('mode-make');
const resMove    = $('res-move');
const resScore   = $('res-score');
const resDepth   = $('res-depth');
const resPV      = $('res-pv');
const thinkTime  = $('think-time');
const progressBar= $('progress-bar');
const statusPip  = $('status-pip');
const statusMsg  = $('status-msg');
const capTop     = $('captured-top');
const capBot     = $('captured-bottom');
const moveList   = $('move-list');
const promoOver  = $('promo-overlay');
const promoBtns  = $('promo-btns');
const toastEl    = $('toast');
const rankLabels = $('rank-labels');
const fileLabels = $('file-labels');
const ghost      = $('drag-ghost');
const engineDot  = $('engine-dot');
const engineLbl  = $('engine-label');

/* ═══════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════ */
function boot() {
  buildCoords();
  renderBoard();
  syncFEN();
  syncTurnUI();
  syncCastleUI();
  attachEvents();
  loadEngine();
}

/* ═══════════════════════════════════════════════════════════
   COORDINATE LABELS
═══════════════════════════════════════════════════════════ */
function buildCoords() {
  rankLabels.innerHTML = '';
  fileLabels.innerHTML = '';
  const ranks = flipped ? ['1','2','3','4','5','6','7','8'] : ['8','7','6','5','4','3','2','1'];
  const files = flipped ? ['h','g','f','e','d','c','b','a'] : ['a','b','c','d','e','f','g','h'];
  ranks.forEach(r => { const s=document.createElement('span'); s.textContent=r; rankLabels.appendChild(s); });
  files.forEach(f => { const s=document.createElement('span'); s.textContent=f; fileLabels.appendChild(s); });
}

/* ═══════════════════════════════════════════════════════════
   BOARD RENDERING
═══════════════════════════════════════════════════════════ */
function renderBoard() {
  board.innerHTML = '';
  const raw   = chess.board();          // [rank0=rank8][file0=a]
  const inChk = chess.inCheck();
  const kingPos = inChk ? locateKing(chess.turn()) : null;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const br = flipped ? 7 - row : row;    // board rank index
      const bc = flipped ? 7 - col : col;    // board col index
      const file = 'abcdefgh'[bc];
      const rank = 8 - br;
      const sq   = file + rank;
      const pd   = raw[br][bc];              // piece data or null
      const isLight = (br + bc) % 2 === 0;

      const el = document.createElement('div');
      el.className = `sq ${isLight ? 'light' : 'dark'}`;
      el.dataset.sq = sq;

      // Highlights
      if (selSq === sq)                                  el.classList.add('selected');
      if (lastMove?.from === sq || lastMove?.to === sq)  el.classList.add(lastMove.from===sq?'last-from':'last-to');
      if (engMove?.from === sq)                          el.classList.add('eng-from');
      if (engMove?.to   === sq)                          el.classList.add('eng-to');
      if (kingPos === sq)                                el.classList.add('in-check');

      // Legal-move dot
      if (legalTargets.includes(sq)) {
        if (pd) el.classList.add('has-piece');
        const dot = document.createElement('div');
        dot.className = 'move-dot';
        el.appendChild(dot);
      }

      // Piece
      if (pd) {
        const pe  = document.createElement('div');
        pe.className = `piece ${pd.color}${pd.type}`;
        pe.dataset.sq  = sq;
        pe.addEventListener('mousedown', onPieceMouseDown);
        el.appendChild(pe);
      }

      el.addEventListener('click', onSqClick);
      board.appendChild(el);
    }
  }

  updateCaptures();
  updateHistory();
}

function locateKing(color) {
  const b = chess.board();
  for (let r=0;r<8;r++) for (let c=0;c<8;c++)
    if (b[r][c]?.type==='k' && b[r][c]?.color===color)
      return 'abcdefgh'[c]+(8-r);
  return null;
}

/* ═══════════════════════════════════════════════════════════
   SQUARE CLICK
═══════════════════════════════════════════════════════════ */
function onSqClick(e) {
  if (dragInfo) return;
  const sq = e.currentTarget.dataset.sq;
  const pd = chess.get(sq);

  if (selSq) {
    if (sq === selSq)              { clearSel(); renderBoard(); return; }
    if (legalTargets.includes(sq)) { attemptMove(selSq, sq);   return; }
    if (pd?.color === chess.turn()){ selectSq(sq);              return; }
    clearSel(); renderBoard();
    return;
  }

  if (pd?.color === chess.turn()) selectSq(sq);
}

function selectSq(sq) {
  selSq = sq;
  legalTargets = chess.moves({ square: sq, verbose:true }).map(m=>m.to);
  renderBoard();
}

function clearSel() {
  selSq = null; legalTargets = [];
}

/* ═══════════════════════════════════════════════════════════
   MOVE EXECUTION
═══════════════════════════════════════════════════════════ */
async function attemptMove(from, to, promoOverride) {
  const moves = chess.moves({ square: from, verbose:true }).filter(m=>m.to===to);
  if (!moves.length) { clearSel(); renderBoard(); return; }

  const needsPromo = moves.some(m => m.flags.includes('p'));
  if (needsPromo && !promoOverride) {
    const color = chess.get(from)?.color;
    const promo = await askPromo(color);
    attemptMove(from, to, promo);
    return;
  }

  const moveObj = { from, to };
  if (promoOverride) moveObj.promotion = promoOverride;

  const result = chess.move(moveObj);
  if (!result) { clearSel(); renderBoard(); return; }

  lastMove = { from, to };
  engMove  = null;
  clearSel();
  syncFEN();
  syncTurnUI();
  syncCastleUI();
  renderBoard();

  if (chess.isGameOver()) handleGameOver();
}

function handleGameOver() {
  setTimeout(() => {
    if (chess.isCheckmate())
      showToast('♛ Skakmat! ' + (chess.turn()==='w' ? 'Hitam' : 'Putih') + ' menang!', 'success', 5000);
    else if (chess.isDraw() || chess.isStalemate())
      showToast('🤝 Remis! ' + drawReason(), 'info', 5000);
  }, 150);
}
function drawReason() {
  if (chess.isStalemate())          return '(Stalemate)';
  if (chess.isThreefoldRepetition())return '(Pengulangan 3x)';
  if (chess.isInsufficientMaterial())return '(Material tidak cukup)';
  return '(Lima puluh gerakan)';
}

/* ═══════════════════════════════════════════════════════════
   PROMOTION DIALOG
═══════════════════════════════════════════════════════════ */
function askPromo(color) {
  return new Promise(resolve => {
    promoResolve = resolve;
    promoBtns.innerHTML = '';
    ['q','r','b','n'].forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'promo-btn';
      btn.title = {q:'Ratu',r:'Benteng',b:'Gajah',n:'Kuda'}[p];
      btn.onclick = () => { promoOver.hidden=true; resolve(p); };

      const pieceDiv = document.createElement('div');
      pieceDiv.className = `piece ${color}${p}`;
      pieceDiv.style.width = '100%';
      pieceDiv.style.height = '100%';
      btn.appendChild(pieceDiv);

      promoBtns.appendChild(btn);
    });
    promoOver.hidden = false;
  });
}

/* ═══════════════════════════════════════════════════════════
   DRAG & DROP
═══════════════════════════════════════════════════════════ */
function onPieceMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();

  const sq = e.currentTarget.dataset.sq;
  const pd = chess.get(sq);
  if (!pd || pd.color !== chess.turn()) return;

  dragInfo = { from: sq };
  selectSq(sq);
  renderBoard();

  ghost.className = `piece ${pd.color}${pd.type}`;
  ghost.style.width = 'var(--sq)';
  ghost.style.height = 'var(--sq)';
  ghost.style.display = 'block';
  posGhost(e.clientX, e.clientY);

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup',   onMouseUp);
}

function onMouseMove(e) {
  if (!dragInfo) return;
  posGhost(e.clientX, e.clientY);
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
  const el = document.elementFromPoint(e.clientX, e.clientY);
  el?.closest('.sq')?.classList.add('drag-over');
}

function onMouseUp(e) {
  if (!dragInfo) return;
  ghost.style.display = 'none';
  ghost.className = '';
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));

  const el  = document.elementFromPoint(e.clientX, e.clientY);
  const sqEl = el?.closest('.sq');
  const toSq = sqEl?.dataset.sq;

  if (dragInfo.from === 'reserve') {
    if (toSq) {
      chess.put({ type: dragInfo.type, color: dragInfo.color }, toSq);
      lastMove = null;
      engMove = null;
      clearSel();
      syncFEN();
      renderBoard();
    }
  } else if (toSq && toSq !== dragInfo.from && legalTargets.includes(toSq)) {
    attemptMove(dragInfo.from, toSq);
  } else if (!toSq && dragInfo.from !== 'reserve') {
    // Dropped outside the board -> remove the piece!
    chess.remove(dragInfo.from);
    lastMove = null;
    engMove = null;
    clearSel();
    syncFEN();
    renderBoard();
  } else {
    clearSel(); renderBoard();
  }

  dragInfo = null;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup',   onMouseUp);
}

function posGhost(x, y) {
  ghost.style.left = x + 'px';
  ghost.style.top  = y + 'px';
}

/* ═══════════════════════════════════════════════════════════
   TOUCH DRAG & RESERVE PIECE DRAG
═══════════════════════════════════════════════════════════ */
function onReserveMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();

  const wrap = e.currentTarget;
  const color = wrap.dataset.color;
  const type = wrap.dataset.type;

  dragInfo = { from: 'reserve', color, type };
  clearSel();
  renderBoard();

  ghost.className = `piece ${color}${type}`;
  ghost.style.width = 'var(--sq)';
  ghost.style.height = 'var(--sq)';
  ghost.style.display = 'block';
  posGhost(e.clientX, e.clientY);

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup',   onMouseUp);
}

function onReserveTouchStart(e) {
  const t = e.touches[0];
  const wrap = e.currentTarget;
  const color = wrap.dataset.color;
  const type = wrap.dataset.type;

  e.preventDefault();
  dragInfo = { from: 'reserve', color, type };
  clearSel();
  renderBoard();

  ghost.className = `piece ${color}${type}`;
  ghost.style.width = 'var(--sq)';
  ghost.style.height = 'var(--sq)';
  ghost.style.display = 'block';
  posGhost(t.clientX, t.clientY);

  document.addEventListener('touchmove', onTouchMove, { passive:false });
  document.addEventListener('touchend',   onTouchEnd);
}

function onTouchMove(e) {
  if (!dragInfo) return;
  e.preventDefault();
  const t = e.touches[0];
  posGhost(t.clientX, t.clientY);
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
  document.elementFromPoint(t.clientX,t.clientY)?.closest('.sq')?.classList.add('drag-over');
}

function onTouchEnd(e) {
  if (!dragInfo) return;
  ghost.style.display = 'none';
  ghost.className = '';
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));

  const t = e.changedTouches[0];
  const sqEl = document.elementFromPoint(t.clientX, t.clientY)?.closest('.sq');
  const toSq = sqEl?.dataset.sq;

  if (dragInfo.from === 'reserve') {
    if (toSq) {
      chess.put({ type: dragInfo.type, color: dragInfo.color }, toSq);
      lastMove = null;
      engMove = null;
      clearSel();
      syncFEN();
      renderBoard();
    }
  } else if (toSq && toSq !== dragInfo.from && legalTargets.includes(toSq)) {
    attemptMove(dragInfo.from, toSq);
  } else if (!toSq && dragInfo.from !== 'reserve') {
    chess.remove(dragInfo.from);
    lastMove = null;
    engMove = null;
    clearSel();
    syncFEN();
    renderBoard();
  } else {
    clearSel(); renderBoard();
  }

  dragInfo = null;
  document.removeEventListener('touchmove', onTouchMove);
  document.removeEventListener('touchend',   onTouchEnd);
}

board.addEventListener('touchstart', e => {
  const t   = e.touches[0];
  const sqEl = document.elementFromPoint(t.clientX,t.clientY)?.closest('.sq');
  if (!sqEl) return;
  const sq = sqEl.dataset.sq;
  const pd = chess.get(sq);

  if (selSq && legalTargets.includes(sq)) {
    e.preventDefault(); attemptMove(selSq, sq); return;
  }
  if (pd?.color === chess.turn()) {
    e.preventDefault();
    dragInfo = { from: sq };
    selectSq(sq); renderBoard();
    ghost.className = `piece ${pd.color}${pd.type}`;
    ghost.style.width = 'var(--sq)';
    ghost.style.height = 'var(--sq)';
    ghost.style.display = 'block';
    posGhost(t.clientX, t.clientY);

    document.addEventListener('touchmove', onTouchMove, { passive:false });
    document.addEventListener('touchend',   onTouchEnd);
  }
}, { passive:false });

/* ═══════════════════════════════════════════════════════════
   CAPTURED PIECES
═══════════════════════════════════════════════════════════ */
const PIECE_VALUE = { p:1, n:3, b:3, r:5, q:9, k:0 };

function updateCaptures() {
  const history = chess.history({ verbose:true });
  const byWhite = [], byBlack = [];

  history.forEach(m => {
    if (!m.captured) return;
    const capColor = m.color === 'w' ? 'b' : 'w';
    const key = capColor + m.captured.toUpperCase();
    (m.color === 'w' ? byWhite : byBlack).push(UNICODE[key]);
  });

  const sort = arr => [...arr].sort((a,b) => {
    const val = u => Object.keys(UNICODE).indexOf(Object.keys(UNICODE).find(k=>UNICODE[k]===u));
    return val(a) - val(b);
  });

  capTop.textContent = sort(flipped ? byWhite : byBlack).join('');
  capBot.textContent = sort(flipped ? byBlack : byWhite).join('');
}

/* ═══════════════════════════════════════════════════════════
   MOVE HISTORY
═══════════════════════════════════════════════════════════ */
function updateHistory() {
  moveList.innerHTML = '';
  const moves = chess.history();
  moves.forEach((san, i) => {
    if (i % 2 === 0) {
      const n = document.createElement('span');
      n.className = 'mv-num';
      n.textContent = (Math.floor(i/2)+1) + '.';
      moveList.appendChild(n);
    }
    const s = document.createElement('span');
    s.className = 'mv-san' + (i===moves.length-1 ? ' active' : '');
    s.textContent = san;
    s.title = 'Klik untuk menyalin';
    s.onclick = () => { navigator.clipboard.writeText(san); showToast('Disalin: '+san,'info'); };
    moveList.appendChild(s);
  });
  moveList.scrollLeft = moveList.scrollWidth;
}

/* ═══════════════════════════════════════════════════════════
   FEN / SYNC
═══════════════════════════════════════════════════════════ */
function syncFEN() { fenInput.value = chess.fen(); }

function applyFEN() {
  const raw = fenInput.value.trim();
  if (!raw) return;
  try {
    chess.load(raw);
    engMove=null; lastMove=null; clearSel();
    syncTurnUI(); syncCastleUI(); renderBoard(); syncFEN();
    showToast('FEN diterapkan ✓', 'success');
  } catch(err) {
    showToast('FEN tidak valid!', 'error');
  }
}

function syncTurnUI() {
  const t = chess.turn();
  turnW.checked = t === 'w';
  turnB.checked = t === 'b';
}

function syncCastleUI() {
  const c = chess.fen().split(' ')[2] || '-';
  cWK.checked = c.includes('K');
  cWQ.checked = c.includes('Q');
  cBK.checked = c.includes('k');
  cBQ.checked = c.includes('q');
}

function castleString() {
  let s = '';
  if (cWK.checked) s+='K';
  if (cWQ.checked) s+='Q';
  if (cBK.checked) s+='k';
  if (cBQ.checked) s+='q';
  return s || '-';
}

function rebuildFENFromUI() {
  const parts = chess.fen().split(' ');
  parts[1] = turnW.checked ? 'w' : 'b';
  parts[2] = castleString();
  return parts.join(' ');
}

function applyFENFromUI() {
  try {
    chess.load(rebuildFENFromUI());
    renderBoard(); syncFEN();
  } catch(e) {}
}

/* ═══════════════════════════════════════════════════════════
   STOCKFISH ENGINE LOADER
═══════════════════════════════════════════════════════════ */
async function loadEngine() {
  setStatus('loading', 'Memuat Stockfish engine…');

  for (const src of SF_SOURCES) {
    try {
      const worker = await tryLoadWorker(src);
      if (worker) {
        stockfish = worker;
        stockfish.addEventListener('message', onSFMessage);
        stockfish.postMessage('uci');
        return;
      }
    } catch(e) {
      console.warn('SF source failed:', src, e);
    }
  }

  setStatus('error', 'Engine gagal dimuat. Coba refresh halaman.');
  showToast('⚠ Stockfish tidak tersedia. Coba buka via HTTP server.', 'error', 6000);
}

async function tryLoadWorker(src) {
  return new Promise((resolve, reject) => {
    let worker;
    const timeout = setTimeout(() => {
      worker?.terminate();
      reject(new Error('timeout'));
    }, 8000);

    const onMsg = e => {
      if (typeof e.data === 'string' && e.data.startsWith('info') || e.data === 'uciok') {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMsg);
        resolve(worker);
      }
    };

    try {
      worker = new Worker(src);
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', err => { clearTimeout(timeout); reject(err); });
      // If local file — test immediately
      if (!src.startsWith('http')) {
        worker.postMessage('uci');
      } else {
        // For CDN, send uci after short delay
        setTimeout(() => { try { worker.postMessage('uci'); } catch(e){} }, 100);
      }
    } catch(e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   STOCKFISH MESSAGES
═══════════════════════════════════════════════════════════ */
function onSFMessage(e) {
  const msg = typeof e.data === 'string' ? e.data : String(e.data ?? '');

  if (msg === 'uciok') {
    sfReady = true;
    stockfish.postMessage('setoption name Hash value 128');
    stockfish.postMessage('ucinewgame');
    stockfish.postMessage('isready');
    setStatus('ready', 'Stockfish siap ✓');
    showToast('Engine Stockfish siap ✓', 'success', 2000);
  }

  if (!sfBusy) return;

  // info line
  if (msg.startsWith('info') && msg.includes('depth')) {
    const dm = msg.match(/depth (\d+)/);
    const sm = msg.match(/score (cp|mate) (-?\d+)/);
    const pm = msg.match(/ pv (.+)/);

    if (dm) resDepth.textContent = dm[1];

    if (sm) {
      const type=sm[1], val=parseInt(sm[2]);
      if (type==='cp') {
        const s=(val/100).toFixed(2);
        resScore.textContent = (val>=0?'+':'')+s;
        resScore.className = 'res-val '+(val<0?'red':'green');
      } else {
        resScore.textContent = (val>0?'+':'')+'M'+Math.abs(val);
        resScore.className = 'res-val '+(val<0?'red':'green');
      }
    }

    if (pm) {
      resPV.textContent = pm[1].trim().split(' ').slice(0,12).join(' ');
    }
  }

  // bestmove
  if (msg.startsWith('bestmove')) {
    onBestMove(msg);
  }
}

function onBestMove(msg) {
  sfBusy = false;
  stopTimer();
  setCalcUI(false);
  setStatus('ready', 'Analisis selesai ✓');

  const m = msg.match(/bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/);
  if (!m || m[1]==='0000') { showToast('Tidak ada gerakan tersedia','info'); return; }

  const uci   = m[1];
  const from  = uci.slice(0,2);
  const to    = uci.slice(2,4);
  const promo = uci[4] || null;

  // Translate to SAN
  let sanStr = uci;
  try {
    const tmp = new Chess(chess.fen());
    const r   = tmp.move({ from, to, promotion: promo||'q' });
    if (r) sanStr = r.san;
  } catch(e) {}

  resMove.textContent = sanStr;
  engMove = { from, to };
  renderBoard();
  showToast('Gerakan terbaik: ' + sanStr, 'success', 3500);

  if (modeMake.checked) {
    setTimeout(() => attemptMove(from, to, promo||undefined), 500);
  }
}

/* ═══════════════════════════════════════════════════════════
   CALCULATE
═══════════════════════════════════════════════════════════ */
function calculate() {
  if (!sfReady || !stockfish) { showToast('Engine belum siap. Tunggu sebentar…','error'); return; }
  if (chess.isGameOver())      { showToast('Permainan sudah selesai!','info');             return; }

  if (sfBusy) {
    stockfish.postMessage('stop');
    return;
  }

  sfBusy = true;
  engMove = null;
  resMove.textContent = '…';
  resScore.textContent = '…';
  resDepth.textContent = '…';
  resPV.textContent    = '…';

  setCalcUI(true);
  setStatus('working', 'Menganalisis posisi…');

  const fen  = rebuildFENFromUI();
  const secs = Math.max(1, parseInt(thinkTime.value)||3);

  stockfish.postMessage('position fen ' + fen);
  stockfish.postMessage('go movetime ' + (secs * 1000));

  startTimer(secs);
}

function setCalcUI(busy) {
  calcLabel.textContent  = busy ? 'Berhenti' : 'Hitung Posisi Terbaik';
  calcSpinner.hidden     = !busy;
}

/* ═══════════════════════════════════════════════════════════
   PROGRESS TIMER
═══════════════════════════════════════════════════════════ */
function startTimer(secs) {
  stopTimer();
  const total = secs * 1000;
  const t0    = Date.now();
  progressBar.style.width = '0%';
  timerTick = setInterval(() => {
    const pct = Math.min(100, ((Date.now()-t0)/total)*100);
    progressBar.style.width = pct + '%';
    if (pct >= 100) stopTimer();
  }, 50);
}

function stopTimer() {
  if (timerTick) { clearInterval(timerTick); timerTick=null; }
}

/* ═══════════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════════ */
function setStatus(state, text) {
  statusPip.className = 'status-pip ' + state;
  statusMsg.textContent = text;
  engineDot.className = 'badge-dot ' + state;
  engineLbl.textContent = text;
}

let toastTimer = null;
function showToast(msg, type='', ms=2500) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = 'toast show ' + type;
  toastTimer = setTimeout(() => { toastEl.className='toast'; }, ms);
}

/* ═══════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════ */
function attachEvents() {
  // Board buttons
  btnStart.onclick  = () => {
    chess.reset(); resetView();
    showToast('Posisi awal ♟','success');
  };
  btnSetFen.onclick = applyFEN;
  btnClear.onclick  = () => {
    chess.load('8/8/8/8/8/8/8/8 w - - 0 1');
    resetView(); showToast('Papan dikosongkan','info');
  };
  btnFlip.onclick = () => {
    flipped = !flipped; buildCoords(); renderBoard();
    showToast('Papan dibalik ⇅','info');
  };
  btnUndo.onclick = () => {
    if (!chess.history().length) return;
    chess.undo(); lastMove=null; engMove=null; clearSel();
    syncFEN(); syncTurnUI(); syncCastleUI(); renderBoard();
  };

  // FEN
  btnCopyFen.onclick = () => { navigator.clipboard.writeText(chess.fen()); showToast('FEN disalin ⎘','success'); };
  fenInput.addEventListener('keydown', e => { if(e.key==='Enter') applyFEN(); });

  // PGN copy
  btnCopyPGN.onclick = () => { navigator.clipboard.writeText(chess.pgn()); showToast('PGN disalin ⎘','success'); };

  // Turn radio
  [turnW, turnB].forEach(r => r.addEventListener('change', applyFENFromUI));

  // Castling
  [cWK,cWQ,cBK,cBQ].forEach(c => c.addEventListener('change', applyFENFromUI));

  // Calculate
  btnCalc.onclick = calculate;

  // Right-click = delete piece or clear selection
  board.addEventListener('contextmenu', e => {
    e.preventDefault();
    const sqEl = e.target.closest('.sq');
    if (sqEl) {
      const sq = sqEl.dataset.sq;
      if (chess.get(sq)) {
        chess.remove(sq);
        resetView();
        showToast('Bidak dihapus','info');
        return;
      }
    }
    clearSel(); engMove=null; renderBoard();
  });

  // Reserve pieces
  document.querySelectorAll('.reserve-piece-wrap').forEach(wrap => {
    wrap.addEventListener('mousedown', onReserveMouseDown);
    wrap.addEventListener('touchstart', onReserveTouchStart, { passive:false });
  });
}

function resetView() {
  lastMove=null; engMove=null; clearSel();
  syncFEN(); syncTurnUI(); syncCastleUI(); renderBoard();
}

/* ═══════════════════════════════════════════════════════════
   START
═══════════════════════════════════════════════════════════ */
boot();
