
// --- helper: ensure thumb URL contains token when needed ---
function ensureThumbUrl(url, scope) {
  try {
    if (!url) return url;
    if (scope === 'personal' && typeof token !== 'undefined' && token) {
      if (url.indexOf('?') === -1) return url + '?t=' + encodeURIComponent(token);
      return url + '&t=' + encodeURIComponent(token);
    }
  } catch(e){}
  return url;
}

// app.js — client-side logic (ES module)
// Modifications: improved trash icon used in index.html, keep topbar visible while cursor is over it,
// allow native context menu when right-clicking the viewed photo, and add a small "More" popup showing date.

const BLOCKS_PER_LOAD = 4;
const M_HEIGHT = 120; // constant thumbnail height (used as baseline)
let token = localStorage.getItem('jwt') || null;
let currentScope = 'shared';
let loading = false;
let loadedBlocks = 0;
let allPhotos = []; // flat list of photos in DOM order for global navigation
let nextUploadScope = null; // used when upload initiated via context menu

const blocksEl = document.getElementById('blocks');
const loader = document.getElementById('loader');

// File input and controls
const fileInput = document.getElementById('file-input');
const pickBtn = document.getElementById('pick-file-btn');
const pickedText = document.getElementById('file-picked-text');

if (pickBtn && fileInput) {
  pickBtn.addEventListener('click', () => {
    nextUploadScope = document.getElementById('scope-select') ? document.getElementById('scope-select').value : null;
    fileInput.click();
  });
  pickBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      nextUploadScope = document.getElementById('scope-select') ? document.getElementById('scope-select').value : null;
      fileInput.click();
    }
  });
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    // Show selected filename(s) but DO NOT start uploading immediately.
    const files = fileInput.files && fileInput.files.length ? Array.from(fileInput.files) : [];
    pickedText.textContent = files.length ? (files.length > 1 ? (files.length + ' файлов') : files[0].name) : '';

    // If the top "+" menu requested the picker, stash files for the top menu and show its "Загрузить" button.
    if (window._deferNextFileToTop) {
      window._topDeferredFiles = files;
      window._deferNextFileToTop = false;
      if (typeof window._suppressDocClick !== 'undefined') window._suppressDocClick = false;
      try { if (topFilePickedText || typeof topPickedText !== 'undefined') {} } catch(e) {}
      try {
        var tp = document.getElementById('top-file-picked-text');
        if (tp) tp.textContent = files.length ? (files.length > 1 ? (files.length + ' файлов') : files[0].name) : '';
        var tub = document.getElementById('top-upload-btn');
        if (tub) tub.classList.remove('hidden');
      } catch(e){}
      // do not auto-upload
      return;
    }

    
    // If nextUploadScope was set (picker initiated with scope or via context menu), auto-upload immediately.
    if (nextUploadScope && files && files.length) {
      const scopeToUse = nextUploadScope || (document.getElementById('scope-select') ? document.getElementById('scope-select').value : currentScope);
      nextUploadScope = null;
      Array.from(files).forEach(f => {
        if (f && f.type && f.type.startsWith('image/')) uploadWithPreview(f, scopeToUse);
      });
      try { fileInput.value = ''; } catch(e){}
      if (pickedText) pickedText.textContent = '';
      return;
    }
// Otherwise, stash files for the sidebar uploader and show the sidebar "Загрузить" action.
    window._deferredFiles = files;
    const sideUploadBtn = document.getElementById('upload-btn');
    if (sideUploadBtn) {
      sideUploadBtn.dataset.pending = '1';
      sideUploadBtn.textContent = 'Загрузить';
    }
    // do not auto-upload
  });
}

function setActiveButton(scope) {
  document.getElementById('btn-shared').classList.toggle('active', scope === 'shared');
  document.getElementById('btn-all').classList.toggle('active', scope === 'personal');
  document.getElementById('btn-shared').setAttribute('aria-pressed', scope === 'shared');
  document.getElementById('btn-all').setAttribute('aria-pressed', scope === 'personal');
}

async function apiGet(path) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { headers, credentials: 'same-origin' });
  if (res.status === 401) {
    showLoggedOut();
    return [];
  }
  return res.json().catch(() => null);
}

async function apiPost(path, body, isForm = false) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: isForm ? body : JSON.stringify(body),
    credentials: 'same-origin'
  });
  return res;
}

async function loadBlocks(start = 0, count = BLOCKS_PER_LOAD) {
  if (loading) return;
  loading = true;
  loader.classList.remove('hidden');
  try {
    const data = await apiGet(`/api/blocks?scope=${currentScope}&start=${start}&count=${count}`);
    renderBlocks(data);
    loadedBlocks += (data && data.length) ? data.length : 0;
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
    loader.classList.add('hidden');
  }
}

function renderBlocks(blocks) {
  if (!blocks || !blocks.length) {
    if (loadedBlocks === 0) {
      blocksEl.innerHTML = '<div class=\"loader\">Пусто</div>';
    }
    return;
  }
  for (const b of blocks) {
    const block = document.createElement('section');
    block.className = 'block';
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = b.date;
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';

    for (const p of b.photos) {
      if (p.scope === 'personal' && currentScope !== 'personal') continue;

      if (p.id !== undefined && p.id !== null) {
        const exists = allPhotos.find(x => String(x.id) === String(p.id));
        if (exists) continue;
      }

      const t = document.createElement('div');
      t.className = 'thumb';
      if (p.id !== undefined && p.id !== null) t.dataset.photoId = String(p.id);
      t.style.height = (M_HEIGHT) + 'px';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      setImageSrcWithAuth(img, ensureThumbUrl(p.thumb_url, (p.scope||previewObj.scope||"")));
      img.alt = p.orig_name || 'photo';
      // store potential full url and original dimensions if provided by server
      if (p.full_url) t.dataset.fullUrl = p.full_url;
      if (p.orig_width) t.dataset.origWidth = String(p.orig_width);
      if (p.orig_height) t.dataset.origHeight = String(p.orig_height);

      img.addEventListener('load', () => {
        try {
          const aspect = img.naturalWidth && img.naturalHeight ? (img.naturalWidth / img.naturalHeight) : 1;
          const w = Math.max(40, Math.round(M_HEIGHT * aspect));
          t.style.width = w + 'px';
          img.style.height = '100%';
          img.style.width = 'auto';
        } catch(e) {}
      });

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '';
      t.appendChild(img);
      t.appendChild(badge);

      // Also attach block-date for potential lookup from thumb
      if (b.date) t.dataset.blockDate = b.date;

      allPhotos.push({ id: p.id, full_url: p.full_url || null, thumb_url: p.thumb_url, orig_name: p.orig_name, scope: p.scope || 'shared', blockDate: b.date || null });

      t.addEventListener('click', () => openOverlayById(p.id));

      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenuForThumb(e, t, p);
      });

      thumbs.appendChild(t);
    }

    block.appendChild(date);
    block.appendChild(thumbs);
    if (thumbs.children.length > 0) blocksEl.appendChild(block);
  }
}

// Overlay logic
const overlay = document.getElementById('overlay');
const overlayImg = document.getElementById('overlay-img');
const overlayLoader = document.getElementById('overlay-loader');
const leftBtn = document.getElementById('left-btn');
const rightBtn = document.getElementById('right-btn');
// close button removed: keep safe guard if exists
const closeBtn = document.getElementById('close-btn');
let currentList = [];
let currentIndex = 0;

// topbar elements (new)
const overlayTopbar = document.getElementById('overlay-topbar');
const confirmModal = document.getElementById('confirm-modal');
const confirmYesBtn = document.getElementById('confirm-yes');
const confirmNoBtn = document.getElementById('confirm-no');

// showConfirm returns a Promise that resolves true if user confirms, false otherwise
function showConfirm(message){
  return new Promise((resolve)=>{
    if(!confirmModal){ resolve(true); return; }
    const txt = confirmModal.querySelector('.confirm-text');
    if(txt) txt.textContent = message || 'Подтвердите действие';
    confirmModal.classList.remove('hidden');
    confirmModal.setAttribute('aria-hidden','false');

    function cleanup(result){
      confirmModal.classList.add('hidden');
      confirmModal.setAttribute('aria-hidden','true');
      confirmYesBtn.removeEventListener('click', onYes);
      confirmNoBtn.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      resolve(result);
    }
    function onYes(e){ e.stopPropagation(); cleanup(true); }
    function onNo(e){ e.stopPropagation(); cleanup(false); }
    function onKey(e){ if(e.key === 'Escape') cleanup(false); }
    function onDocClick(e){ if(!confirmModal.querySelector('.confirm-box').contains(e.target)) cleanup(false); }

    confirmYesBtn.addEventListener('click', onYes);
    confirmNoBtn.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    // slight delay to allow current click to finish before we capture outside clicks
    setTimeout(()=> document.addEventListener('click', onDocClick), 0);
  });
}

const topCloseBtn = document.getElementById('top-close-btn');
const deleteBtn = document.getElementById('delete-btn');
const shareBtn = document.getElementById('share-btn');
const zoomBtn = document.getElementById('zoom-btn');
const moreBtn = document.getElementById('more-btn');
const morePopup = document.getElementById('more-popup');

// navigation visibility state (which third the cursor is in)
let navZone = 'center'; // 'left' | 'right' | 'center' | 'none'
let topbarTimer = null;
let morePopupVisible = false;

function applySizeFrom(nw, nh) {
  try {
    overlayImg.style.background = 'transparent';
    const maxW = Math.round(window.innerWidth * 0.92);
    const maxH = Math.round(window.innerHeight * 0.92);
    if (nw && nh) {
      const imgAspect = nw / nh;
      const maxAspect = maxW / maxH;
      if (imgAspect > maxAspect) {
        overlayImg.style.width = maxW + 'px';
        overlayImg.style.height = 'auto';
      } else {
        overlayImg.style.height = maxH + 'px';
        overlayImg.style.width = 'auto';
      }
    } else {
      overlayImg.style.width = '';
      overlayImg.style.height = '';
    }
  } catch(e) {
    console.debug('applySizeFrom error', e);
  }
}


function revokeBlobUrlIfAny() {
  const b = overlayImg.dataset.blobUrl;
  if (b) {
    try { URL.revokeObjectURL(b); } catch(e) {}
    delete overlayImg.dataset.blobUrl;
  }
  try { if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); } } catch(e) {}
  delete overlayImg.dataset.waitingForFull;
}

// Build candidate full URLs from available info (thumb path, known full_url, patterns)
function buildFullUrlCandidates(item, thumbSrc) {
  const candidates = [];
  if (item && item.full_url) candidates.push(item.full_url);
  try {
    if (item && item.id) {
      const el = document.querySelector(`.thumb[data-photo-id="${CSS.escape(String(item.id))}"]`);
      if (el && el.dataset && el.dataset.fullUrl) candidates.push(el.dataset.fullUrl);
    }
  } catch(e){}
  if (thumbSrc) {
    if (thumbSrc.includes('/thumbs/')) candidates.push(thumbSrc.replace('/thumbs/', '/images/'));
    candidates.push(thumbSrc.replace(/thumb[_-]/i, ''));
    candidates.push(thumbSrc.replace(/[_-]thumb(\.[a-zA-Z0-9]+)$/i, '$1'));
    candidates.push(thumbSrc.split('?')[0]);
    candidates.push(thumbSrc.replace('/thumb', '/full'));
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c) continue;
    const v = c.toString();
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// Attempts to load a full image from a list of candidate URLs.
async function tryLoadFullFromCandidates(item, candidates) {
  for (const url of candidates) {
    if (!url) continue;
    try {
      if (item && item.scope === 'personal') {
        try { console.debug('tryLoadFullFromCandidates: personal fetch', url); } catch(e){}
        const headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(url, { headers, credentials: 'same-origin' });
        if (!res.ok) continue;
        const blob = await res.blob();
        const blobUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        try { console.debug('tryLoadFullFromCandidates: got blobUrl', blobUrl); } catch(e){}
        return { src: blobUrl, isBlob: true };
      } else {
        const img = new Image();
        img.src = url;
        await new Promise((resolve, reject) => {
          let settled = false;
          const tmo = setTimeout(() => { if (!settled) { settled = true; reject(new Error('timeout')); } }, 8000);
          img.onload = () => { if (!settled) { settled = true; clearTimeout(tmo); resolve(true); } };
          img.onerror = () => { if (!settled) { settled = true; clearTimeout(tmo); reject(new Error('error')); } };
        });
        return { src: img.src, isBlob: false, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
      }
    } catch (err) {
      console.debug('candidate failed', url, err && err.message);
      continue;
    }
  }
  return null;
}

async function loadImage(item) {
  revokeBlobUrlIfAny();
  if (!item) { overlayImg.src = ''; overlayImg.alt = ''; return; }

  const thumbSrc = item.thumb_url || item.preview_url || item.full_url || '';
  overlayImg.alt = item.orig_name || 'photo';
  overlayImg.style.objectFit = 'contain';
  overlayImg.dataset.waitingForFull = '1';
  try {
    const startUrl = window.ensureThumbUrl(thumbSrc, item && item.scope ? item.scope : undefined);
    // try loading server image with retries; fallback to preview and keep retrying
    await window.tryLoadImageWithRetries(overlayImg, startUrl, item && item.preview_url ? item.preview_url : thumbSrc, { maxAttempts: 6, initialDelay: 500 });
    } catch(e) {
    // fallback: try direct full_url without auth manipulation
    try {
      if (item && item.full_url) try { setImageSrcWithAuth(overlayImg, ensureThumbUrl(item.full_url, item.scope)); } catch(e) { overlayImg.src = item.full_url; }
    } catch(e2){}
  }
  // asynchronously fetch photo metadata so popup can show owner and minute-precision time
  (async () => {
    try {
      if (item && item.id) {
        const info = await apiGet(`/api/photo/${encodeURIComponent(item.id)}`);
        if (info) {
          if (info.time) item.uploaded_at = info.time;
          if (info.owner) item.owner = info.owner;
          if (info.orig_name) item.orig_name = info.orig_name;
          // reflect on DOM thumb dataset if present
          try {
            const th = document.querySelector(`.thumb[data-photo-id="${CSS.escape(String(item.id))}"]`);
            if (th) {
              if (info.owner) th.dataset.owner = info.owner;
              if (info.time) th.dataset.time = info.time;
            }
          } catch(e){}
        }
      }
    } catch(e){}
  })();

  try { if (overlayLoader) { overlayLoader.classList.remove('hidden'); overlayLoader.setAttribute('aria-hidden','false'); } } catch(e) {}

  const probe = new Image();
  probe.src = thumbSrc;
  const setDisplaySize = () => {
    try {
      const aspect = probe.naturalWidth && probe.naturalHeight ? (probe.naturalWidth / probe.naturalHeight) : 1;
      const maxW = Math.round(window.innerWidth * 0.92);
      const maxH = Math.round(window.innerHeight * 0.92);
      let targetW = Math.min(maxW, Math.round(aspect * maxH));
      let targetH = Math.min(maxH, Math.round(targetW / aspect));
      if (targetW <= 0 || targetH <= 0) { targetW = maxW; targetH = maxH; }
      applySizeFrom(probe.naturalWidth||0, probe.naturalHeight||0);
    } catch (e) {}
  };
  if (probe.complete) setDisplaySize();
  else probe.onload = setDisplaySize;

  const candidates = buildFullUrlCandidates(item, thumbSrc);

  if (!candidates.length) {
    try { if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); } } catch(e) {}
    delete overlayImg.dataset.waitingForFull;
    return;
  }

  const result = await tryLoadFullFromCandidates(item, candidates);
  if (!result) {
    if (item && item.id) {
      try {
        const info = await apiGet(`/api/photo/${encodeURIComponent(item.id)}`);
        if (info) {
          // save server-provided metadata into the current item so UI can show it
          try {
            if (info.time) item.uploaded_at = info.time;
            if (info.owner) item.owner = info.owner;
            if (info.orig_name) item.orig_name = info.orig_name;
            // ensure currentList is updated reference (it is)
            if (typeof updateNavVisibility === 'function') updateNavVisibility(navZone);
          } catch(e){}
          if (info.full_url) {
            const r2 = await tryLoadFullFromCandidates(item, [info.full_url]);
            if (r2) {
              swapToFull(r2, item);
              return;
            }
          }
        }
        if (info && info.full_url) {
          const r2 = await tryLoadFullFromCandidates(item, [info.full_url]);
          if (r2) {
            swapToFull(r2, item);
            return;
          }
        }
      } catch(e){}
    }
    try { if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); } } catch(e) {}
    delete overlayImg.dataset.waitingForFull;
    return;
  }

  swapToFull(result, item);
}

function swapToFull(result, item) {
  try{ console.debug('swapToFull called', !!result, result && result.isBlob, item && item.scope); }catch(e){}
  if (!result || !result.src) {
    try { if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); } } catch(e) {}
    delete overlayImg.dataset.waitingForFull;
    return;
  }
  if (result.isBlob) overlayImg.dataset.blobUrl = result.src;

  const probe = new Image();
  probe.src = result.src;

  // Ensure overlayImg will update size when the actual image finishes loading into the img element
  overlayImg.onload = () => {
    try {
      applySizeFrom(overlayImg.naturalWidth||0, overlayImg.naturalHeight||0);
      if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); }
    } catch(e) {}
    try { delete overlayImg.dataset.waitingForFull; } catch(e) {}
  };

  const doSwap = () => {
    overlayImg.src = result.src;
    if (probe.naturalWidth && probe.naturalHeight) {
      try {
        const maxW = Math.round(window.innerWidth * 0.92);
        const maxH = Math.round(window.innerHeight * 0.92);
        const w = Math.min(probe.naturalWidth, maxW);
        const h = Math.min(probe.naturalHeight, maxH);
        applySizeFrom(probe.naturalWidth||0, probe.naturalHeight||0);
      } catch(e) {}
    }
    try { if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); } } catch(e) {}
    delete overlayImg.dataset.waitingForFull;
  };
  if (probe.complete) doSwap();
  else probe.onload = doSwap;
  probe.onerror = () => { try { if (overlayLoader) { overlayLoader.classList.add('hidden'); overlayLoader.setAttribute('aria-hidden','true'); } } catch(e) {}
  try { delete overlayImg.dataset.waitingForFull; } catch(e) {} };
}


// ---------- Navigation logic updates (no wrap-around, thirds visibility) ----------

function hasPrev() { return currentIndex > 0; }
function hasNext() { return currentList && currentIndex < currentList.length - 1; }

function updateNavVisibility(zone) {
  leftBtn.classList.remove('show');
  rightBtn.classList.remove('show');

  if (!currentList || !currentList.length) return;

  if (zone === 'left') {
    if (hasPrev()) leftBtn.classList.add('show');
  } else if (zone === 'right') {
    if (hasNext()) rightBtn.classList.add('show');
  }
}

function computeZoneFromX(x) {
  const w = window.innerWidth || document.documentElement.clientWidth;
  if (x < w / 3) return 'left';
  if (x > (2 * w) / 3) return 'right';
  return 'center';
}

async function openOverlayById(photoId) {
  if (!allPhotos || !allPhotos.length) return;
  const idx = allPhotos.findIndex(p => String(p.id) === String(photoId));
  if (idx === -1) return;
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  currentList = allPhotos.slice();
  currentIndex = idx;
  navZone = 'center'; // default hidden until user moves cursor
  showIndex(currentIndex);
  updateNavVisibility(navZone);
}

function openOverlay(block, photo) {
  if (photo && photo.id) return openOverlayById(photo.id);
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  currentList = block.photos;
  currentIndex = block.photos.findIndex(p => p.id === photo.id);
  navZone = 'center';
  showIndex(currentIndex);
  updateNavVisibility(navZone);
}

function closeOverlay() {
  revokeBlobUrlIfAny();
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  overlayImg.src = '';
  applySizeFrom(overlayImg.naturalWidth||0, overlayImg.naturalHeight||0);
  overlayImg.style.background = '';
  currentList = [];
  currentIndex = 0;
  navZone = 'center';
  if (overlayTopbar) overlayTopbar.classList.remove('visible');
  if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
  hideMorePopup();
}

// showIndex now clamps to bounds and DOES NOT wrap
function showIndex(i) {
  if (!currentList || !currentList.length) return;
  const max = currentList.length - 1;
  if (i < 0) i = 0;
  if (i > max) i = max;
  currentIndex = i;
  const item = currentList[currentIndex];
  loadImage(item);

  const next = hasNext() ? currentList[currentIndex + 1] : null;
  const prev = hasPrev() ? currentList[currentIndex - 1] : null;
  if (next && next.full_url && next.scope !== 'personal') preloadUrl(next.full_url);
  if (prev && prev.full_url && prev.scope !== 'personal') preloadUrl(prev.full_url);

  updateNavVisibility(navZone);
}

function preloadUrl(url) {
  const img = new Image();
  img.src = url;
}

// Clicks
leftBtn.addEventListener('click', () => { if (hasPrev()) showIndex(currentIndex - 1); });
rightBtn.addEventListener('click', () => { if (hasNext()) showIndex(currentIndex + 1); });
if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

// topbar wiring
if (topCloseBtn) topCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(); });
// delete button removes current photo (uses existing helper)
if (deleteBtn) deleteBtn.addEventListener('click', async (e) => { e.stopPropagation(); const ok = await showConfirm('Вы уверены, что хотите удалить это фото?'); if (ok) await deletePhotoFromOverlay(); });
// share/zoom are no-op for now
if (shareBtn) shareBtn.addEventListener('click', (e) => { e.stopPropagation(); /* no-op */ });
if (zoomBtn) zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); /* no-op */ });

// MORE popup handling
function getCurrentPhotoDate() {
  // try to get date from currentList item
  if (currentList && currentList[currentIndex]) {
    const it = currentList[currentIndex];
    if (it.blockDate) return it.blockDate;
    if (it.date) return it.date;
    if (it.uploaded_at) return it.uploaded_at;
  }
  // fallback: try to find thumb in DOM and read its block date label
  try {
    const curId = currentList && currentList[currentIndex] && currentList[currentIndex].id ? String(currentList[currentIndex].id) : null;
    if (curId) {
      const thumbEl = document.querySelector(`.thumb[data-photo-id="${CSS.escape(curId)}"]`);
      if (thumbEl) {
        if (thumbEl.dataset.blockDate) return thumbEl.dataset.blockDate;
        const blk = thumbEl.closest('.block');
        if (blk) {
          const dateEl = blk.querySelector('.date');
          if (dateEl) return dateEl.textContent;
        }
      }
    }
  } catch(e){}
  return null;
}



function getCurrentPhotoUser() {
  if (currentList && currentList[currentIndex]) {
    const it = currentList[currentIndex];
    if (it.owner) return it.owner;
    if (it.user) return it.user;
    if (it.uploaded_by) return it.uploaded_by;
  }
  try {
    const curId = currentList && currentList[currentIndex] && currentList[currentIndex].id ? String(currentList[currentIndex].id) : null;
    if (curId) {
      const thumbEl = document.querySelector(`.thumb[data-photo-id="${CSS.escape(curId)}"]`);
      if (thumbEl && thumbEl.dataset.owner) return thumbEl.dataset.owner;
    }
  } catch(e){}
  return null;
}
function showMorePopup() {
  if (!morePopup) return;
  // prefer server-provided uploaded_at (ISO minute precision) or item.time; fallback to block date
  let displayTime = null;
  try {
    const it = currentList && currentList[currentIndex] ? currentList[currentIndex] : null;
    if (it) {
      if (it.uploaded_at) displayTime = it.uploaded_at;
      else if (it.time) displayTime = it.time;
    }
  } catch(e){}
  if (!displayTime) displayTime = getCurrentPhotoDate() || 'Дата неизвестна';
  const user = getCurrentPhotoUser() || 'Неизвестно';
  // build popup showing date/time and user
  morePopup.innerHTML = ''
    + `<div class=\"mp-row mp-title\">Дата и время</div><div class=\"mp-row\">${escapeHtml(displayTime)}</div>`
    + `<div class=\"mp-row mp-title\">Пользователь</div><div class=\"mp-row\">${escapeHtml(user)}</div>`;
  // position under the moreBtn
  try {
    const r = moreBtn.getBoundingClientRect();
    const left = Math.max(12, r.left);
    const top = r.bottom + 8;
    morePopup.style.left = left + 'px';
    morePopup.style.top = top + 'px';
    morePopup.classList.add('visible');
    morePopup.setAttribute('aria-hidden','false');
    morePopupVisible = true;
    // ensure topbar remains visible while popup shown
    if (overlayTopbar) overlayTopbar.classList.add('visible');
    if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
  } catch(e){}
}function hideMorePopup() {
  if (!morePopup) return;
  morePopup.classList.remove('visible');
  morePopup.setAttribute('aria-hidden','true');
  morePopupVisible = false;
}

// simple HTML escape
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]; });
}

if (moreBtn) {
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (morePopupVisible) hideMorePopup();
    else showMorePopup();
  });
}

// close more popup if clicking elsewhere
document.addEventListener('click', (e) => {
  if (!morePopup) return;
  if (morePopupVisible && !morePopup.contains(e.target) && e.target !== moreBtn) hideMorePopup();
});

// keep topbar visible while hovering it or the popup
if (overlayTopbar) {
  overlayTopbar.addEventListener('mouseenter', () => {
    if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
    overlayTopbar.classList.add('visible');
  });
  overlayTopbar.addEventListener('mouseleave', () => {
    if (morePopupVisible) return; // do not hide while popup open
    if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
    topbarTimer = setTimeout(() => {
      overlayTopbar.classList.remove('visible');
      topbarTimer = null;
    }, 1400);
  });
}
if (morePopup) {
  morePopup.addEventListener('mouseenter', () => {
    if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
    overlayTopbar.classList.add('visible');
  });
  morePopup.addEventListener('mouseleave', () => {
    if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
    topbarTimer = setTimeout(() => {
      overlayTopbar.classList.remove('visible');
      topbarTimer = null;
    }, 1400);
  });
}

// Keyboard
window.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft' && hasPrev()) showIndex(currentIndex - 1);
  if (e.key === 'ArrowRight' && hasNext()) showIndex(currentIndex + 1);
  if (e.key === 'Escape') closeOverlay();
});

// Cursor thirds tracking for nav visibility
overlay.addEventListener('mousemove', (e) => {
  if (overlay.classList.contains('hidden')) return;
  navZone = computeZoneFromX(e.clientX);
  updateNavVisibility(navZone);

  // show topbar when cursor moves, then hide after delay when no movement,
  // but do not hide while pointer is over topbar or the popup
  if (overlayTopbar) {
    overlayTopbar.classList.add('visible');
    if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
    topbarTimer = setTimeout(() => {
      // if mouse currently over topbar or popup, leave visible
      try {
        const active = document.querySelector(':hover');
        // we will do a small check: if overlayTopbar or morePopup contains the hovered element, keep visible
        const hovered = document.querySelector(':hover');
      } catch(e){}
      if (!overlayTopbar.matches(':hover') && !(morePopup && morePopup.matches(':hover')) && !morePopupVisible) {
        overlayTopbar.classList.remove('visible');
      }
      topbarTimer = null;
    }, 1400);
  }
});
overlay.addEventListener('mouseleave', () => {
  navZone = 'none';
  updateNavVisibility(navZone);
  if (overlayTopbar && !morePopupVisible) overlayTopbar.classList.remove('visible');
  if (topbarTimer) { clearTimeout(topbarTimer); topbarTimer = null; }
});

// Keep overlay image dimensions responsive when the window is resized.
window.addEventListener('resize', () => {
  try {
    if (overlay.classList.contains('hidden')) return;
    const adjust = () => {
      try {
        const src = overlayImg.src;
        if (!src) return;
        const naturalW = overlayImg.naturalWidth || 0;
        const naturalH = overlayImg.naturalHeight || 0;
        const maxW = Math.round(window.innerWidth * 0.92);
        const maxH = Math.round(window.innerHeight * 0.92);
        if (naturalW && naturalH) {
          const aspect = naturalW / naturalH;
          let w = Math.min(naturalW, maxW);
          let h = Math.min(naturalH, maxH);
          if (w > Math.round(aspect * maxH)) w = Math.round(aspect * maxH);
          if (h > Math.round(w / aspect)) h = Math.round(w / aspect);
          applySizeFrom(overlayImg.naturalWidth||0, overlayImg.naturalHeight||0);
          return;
        }
        const probe = new Image();
        probe.src = src;
        probe.onload = () => {
          try {
            const aspect = (probe.naturalWidth && probe.naturalHeight) ? (probe.naturalWidth / probe.naturalHeight) : 1;
            let targetW = Math.min(maxW, Math.round(aspect * maxH));
            let targetH = Math.min(maxH, Math.round(targetW / aspect));
            if (targetW <= 0 || targetH <= 0) { targetW = maxW; targetH = maxH; }
            applySizeFrom(overlayImg.naturalWidth||0, overlayImg.naturalHeight||0);
          } catch(e){}
        };
      } catch(e){}
    };
    adjust();
  } catch(e) { console.debug('resize handler error', e); }
});

// navigation and UI wiring
document.getElementById('btn-shared').addEventListener('click', () => {
  currentScope = 'shared';
  setActiveButton(currentScope);
  resetAndLoad();
});
document.getElementById('btn-all').addEventListener('click', () => {
  currentScope = 'personal';
  setActiveButton(currentScope);
  resetAndLoad();
});

function resetAndLoad() {
  blocksEl.innerHTML = '';
  loadedBlocks = 0;
  allPhotos = [];
  loadBlocks(0);
}

// login/upload UI
function showLoggedIn() {
  document.getElementById('username').classList.add('hidden');
  document.getElementById('password').classList.add('hidden');
  document.getElementById('login-btn').classList.add('hidden');
  document.getElementById('logout-btn').classList.remove('hidden');
}
function showLoggedOut() {
  token = null;
  localStorage.removeItem('jwt');
  document.getElementById('username').classList.remove('hidden');
  document.getElementById('password').classList.remove('hidden');
  document.getElementById('login-btn').classList.remove('hidden');
  document.getElementById('logout-btn').classList.add('hidden');
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value;
  if (!u || !p) return alert('Введите логин и пароль');
  const res = await apiPost('/api/login', { username: u, password: p });
  if (res.ok) {
    const j = await res.json();
    token = j.token;
    localStorage.setItem('jwt', token);
    showLoggedIn();
    resetAndLoad();
  } else {
    alert('Ошибка входа');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  token = null;
  localStorage.removeItem('jwt');
  showLoggedOut();
  resetAndLoad();
});

(function(){
  const sideUploadBtnEl = document.getElementById('upload-btn');
  if (!sideUploadBtnEl) return;
  sideUploadBtnEl.addEventListener('click', () => {
    // If there are deferred files from a prior selection, start uploading them now.
    if (window._deferredFiles && window._deferredFiles.length) {
      const scopeToUse = document.getElementById('scope-select') ? document.getElementById('scope-select').value : currentScope;
      const filesToUpload = window._deferredFiles.slice();
      window._deferredFiles = null;
      sideUploadBtnEl.removeAttribute('data-pending');
      sideUploadBtnEl.textContent = 'Загрузить';
      Array.from(filesToUpload).forEach(f => uploadWithPreview(f, scopeToUse));
      try { fileInput.value = ''; } catch(e){}
      if (pickedText) pickedText.textContent = '';
      return;
    }
    // Default behaviour: open the file picker (and remember chosen scope)
    nextUploadScope = document.getElementById('scope-select') ? document.getElementById('scope-select').value : null;
    fileInput.click();
  });
})();
// Context menu & deletion (updated to allow native menu on photo)
const mainEl = document.querySelector('main.main');
const ctxMenu = document.getElementById('context-menu');
const ctxUpload = document.getElementById('ctx-upload');
const ctxDelete = document.getElementById('ctx-delete');

let contextTarget = null;

function clampContextMenuPosition(x, y) {
  const menuRect = ctxMenu.getBoundingClientRect();
  const margin = 8;
  let left = x;
  let top = y;
  if (left + menuRect.width + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - menuRect.width - margin);
  }
  if (top + menuRect.height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - menuRect.height - margin);
  }
  return { left, top };
}

function hideContextMenu() {
  ctxMenu.classList.remove('show');
  ctxMenu.setAttribute('aria-hidden', 'true');
  contextTarget = null;
}

document.addEventListener('contextmenu', (e) => {
  const formControl = e.target.closest('input, textarea, select, button, a');
  if (formControl) return;

  // If overlay is open and user right-clicks ON THE IMAGE or on the topbar/popup, allow native menu
  if (!overlay.classList.contains('hidden')) {
    const isOnImage = (e.target === overlayImg) || (!!e.target.closest && !!e.target.closest('#overlay-img'));
    const isOnTopbar = (!!e.target.closest && !!e.target.closest('.overlay-topbar'));
    const isOnPopup = (!!e.target.closest && !!e.target.closest('.more-popup'));
    if (isOnImage || isOnTopbar || isOnPopup) {
      // allow native browser context menu
      hideContextMenu();
      return;
    }
    // If clicked on overlay background (outside image), show custom overlay-specific context menu
    if (e.target === overlay) {
      e.preventDefault();
      const x = e.clientX, y = e.clientY;
      const p = clampContextMenuPosition(x,y);
      ctxMenu.style.left = p.left + 'px'; ctxMenu.style.top = p.top + 'px';
      ctxUpload.style.display = 'none'; ctxDelete.style.display = 'block';
      ctxMenu.classList.add('show'); ctxMenu.setAttribute('aria-hidden','false');
      contextTarget = { type: 'overlay' };
      return;
    }
  }

  const thumb = e.target.closest('.thumb');
  if (thumb) {
    e.preventDefault();
    showContextMenuForThumb(e, thumb, null);
    return;
  }

  const inMain = e.target.closest('main.main');
  if (inMain) {
    e.preventDefault();
    const x = e.clientX, y = e.clientY;
    const p = clampContextMenuPosition(x,y);
    ctxMenu.style.left = p.left + 'px'; ctxMenu.style.top = p.top + 'px';
    ctxUpload.style.display = 'block'; ctxDelete.style.display = 'none';
    ctxMenu.classList.add('show'); ctxMenu.setAttribute('aria-hidden','false');
    contextTarget = { type: 'main' };
    return;
  }
});

document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});

ctxUpload.addEventListener('click', (e) => {
  e.stopPropagation();
  hideContextMenu();
  nextUploadScope = currentScope;
  fileInput.click();
});

ctxDelete.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!contextTarget) return hideContextMenu();
  const target = contextTarget;
  hideContextMenu();
  const ok = await showConfirm('Вы уверены, что хотите удалить это фото?');
  if (!ok) return;
  if (target.type === 'thumb') {
    await deletePhotoByThumb(target.thumbEl, target.photoId);
  } else if (target.type === 'overlay') {
    await deletePhotoFromOverlay();
  }
});

function showContextMenuForThumb(e, thumbEl, photoObj) {
  const x = e.clientX, y = e.clientY;
  const p = clampContextMenuPosition(x,y);
  ctxMenu.style.left = p.left + 'px'; ctxMenu.style.top = p.top + 'px';
  ctxUpload.style.display = 'none'; ctxDelete.style.display = 'block';
  ctxMenu.classList.add('show'); ctxMenu.setAttribute('aria-hidden','false');
  const pid = thumbEl.dataset.photoId || (photoObj && (photoObj.id !== undefined ? String(photoObj.id) : null));
  contextTarget = { type: 'thumb', photoId: pid, thumbEl };
}

async function deletePhotoByThumb(thumbEl, photoId) {
  if (!thumbEl) return;
  if (!photoId) {
    const block = thumbEl.closest('.block');
    thumbEl.parentNode.removeChild(thumbEl);
    const thumbs = block.querySelectorAll('.thumb');
    if (!thumbs.length && block && block.parentNode) block.parentNode.removeChild(block);
    allPhotos = allPhotos.filter(p => p.full_url !== (thumbEl.querySelector && thumbEl.querySelector('img') ? thumbEl.querySelector('img').src : null));
    return;
  }

  try {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(`/api/photo/${encodeURIComponent(photoId)}`, {
      method: 'DELETE',
      headers,
      credentials: 'same-origin'
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => 'Ошибка');
      alert('Ошибка удаления: ' + txt);
      return;
    }

    const block = thumbEl.closest('.block');
    if (thumbEl && thumbEl.parentNode) thumbEl.parentNode.removeChild(thumbEl);
    const thumbs = block.querySelectorAll('.thumb');
    if (!thumbs.length && block && block.parentNode) block.parentNode.removeChild(block);

    allPhotos = allPhotos.filter(p => String(p.id) !== String(photoId));

    if (!overlay.classList.contains('hidden')) {
      const idx = currentList.findIndex(p => String(p.id) === String(photoId));
      if (idx !== -1) {
        currentList.splice(idx, 1);
        if (currentList.length === 0) closeOverlay();
        else {
          if (currentIndex >= currentList.length) currentIndex = currentList.length - 1;
          showIndex(currentIndex);
        }
      }
    }

  } catch (err) {
    console.error(err);
    alert('Network error: ' + err.message);
  }
}

async function deletePhotoFromOverlay() {
  if (!currentList || !currentList.length) return;
  const item = currentList[currentIndex];
  const photoId = item && item.id ? String(item.id) : null;
  const thumbEl = photoId ? document.querySelector(`.thumb[data-photo-id="${CSS.escape(photoId)}"]`) : null;

  if (!photoId) {
    if (thumbEl && thumbEl.parentNode) thumbEl.parentNode.removeChild(thumbEl);
    if (thumbEl) {
      const block = thumbEl.closest('.block');
      if (block) {
        const thumbs = block.querySelectorAll('.thumb');
        if (!thumbs.length && block.parentNode) block.parentNode.removeChild(block);
      }
    }
    currentList.splice(currentIndex,1);
    if (currentList.length === 0) { closeOverlay(); }
    else {
      if (currentIndex >= currentList.length) currentIndex = currentList.length -1;
      showIndex(currentIndex);
    }
    allPhotos = allPhotos.filter(p => p.full_url !== (item.full_url || ''));
    return;
  }

  try {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(`/api/photo/${encodeURIComponent(photoId)}`, {
      method: 'DELETE',
      headers,
      credentials: 'same-origin'
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => 'Ошибка');
      alert('Ошибка удаления: ' + txt);
      return;
    }

    if (thumbEl && thumbEl.parentNode) thumbEl.parentNode.removeChild(thumbEl);
    if (thumbEl) {
      const block = thumbEl.closest('.block');
      if (block) {
        const thumbs = block.querySelectorAll('.thumb');
        if (!thumbs.length && block.parentNode) block.parentNode.removeChild(block);
      }
    }

    const idx = currentList.findIndex(p => String(p.id) === String(photoId));
    if (idx !== -1) currentList.splice(idx,1);
    allPhotos = allPhotos.filter(p => String(p.id) !== String(photoId));

    if (currentList.length === 0) closeOverlay();
    else {
      if (currentIndex >= currentList.length) currentIndex = currentList.length -1;
      showIndex(currentIndex);
    }

  } catch (err) {
    console.error(err);
    alert('Network error: ' + err.message);
  }
}

// Upload with preview and progress (unchanged except ensure previewObj.full_url present)
function uploadWithPreview(file, scopeArg) {
  if (!file) return;
  const now = new Date();
  const dateStr = now.toISOString().slice(0,10);

  const block = document.createElement('section');
  block.className = 'block';
  const date = document.createElement('div');
  date.className = 'date';
  date.textContent = dateStr;
  const thumbs = document.createElement('div');
  thumbs.className = 'thumbs';

  const t = document.createElement('div');
  t.className = 'thumb uploading';
  t.style.height = (M_HEIGHT) + 'px';
  const img = document.createElement('img');
  img.alt = file.name || 'photo';
  img.src = URL.createObjectURL(file);
  img.onload = () => {
    try {
      const aspect = img.naturalWidth && img.naturalHeight ? (img.naturalWidth / img.naturalHeight) : 1;
      const w = Math.max(40, Math.round(M_HEIGHT * aspect));
      t.style.width = w + 'px';
      img.style.height = '100%';
      img.style.width = 'auto';
    } catch(e) {}
  };

  let overlayDiv = document.createElement('div');
  overlayDiv.className = 'preview-overlay';

  let prog = document.createElement('div');
  prog.className = 'upload-progress';
  let bar = document.createElement('div');
  bar.className = 'bar';
  let percent = document.createElement('div');
  percent.className = 'percent';
  percent.textContent = '0%';
  prog.appendChild(bar);
  prog.appendChild(percent);
  overlayDiv.appendChild(prog);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = '';

  t.appendChild(img);
  t.appendChild(badge);
  t.appendChild(overlayDiv);
  thumbs.appendChild(t);
  block.appendChild(date);
  block.appendChild(thumbs);

  // Try to find an existing block with the same date. If found, insert the thumb into it
  const blocksEl = document.querySelector('#blocks') || document.querySelector('.blocks') || document.body;
  let targetBlock = null;
  if (blocksEl) {
    const existing = blocksEl.querySelectorAll('section.block');
    for (let b of existing) {
      const dateEl = b.querySelector('.date');
      if (dateEl && dateEl.textContent === dateStr) {
        targetBlock = b;
        break;
      }
    }
  }

  if (!targetBlock) {
    // No existing block for this date — insert the newly created block at the top
    if (blocksEl && blocksEl.firstChild) blocksEl.insertBefore(block, blocksEl.firstChild);
    else if (blocksEl) blocksEl.appendChild(block);
  } else {
    // Insert thumb into the existing block's .thumbs container at the top
    const existingThumbs = targetBlock.querySelector('.thumbs');
    if (existingThumbs) existingThumbs.insertBefore(t, existingThumbs.firstChild);
    else targetBlock.appendChild(thumbs);
  }

  


  const scope = (typeof scopeArg !== 'undefined' && scopeArg !== null) ? scopeArg : (document.getElementById('scope-select') ? document.getElementById('scope-select').value : 'personal');

  const previewObj = { id: null, full_url: img.src, thumb_url: img.src, orig_name: img.alt, scope: scope, blockDate: dateStr };
  allPhotos.unshift(previewObj);

  t.addEventListener('click', (e) => {
    const idx = allPhotos.findIndex(p => p === previewObj || (p.id !== null && previewObj.id !== null && String(p.id) === String(previewObj.id)));
    if (idx !== -1) {
      currentList = allPhotos.slice();
      currentIndex = idx;
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
      navZone = 'center';
      showIndex(currentIndex);
      updateNavVisibility(navZone);
    }
  });

  t.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenuForThumb(e, t, null);
  });

  let progress = 0;
  let stopped = false;
  const interval = setInterval(() => {
    if (stopped) return;
    if (progress < 60) progress += Math.random() * 8 + 4;
    else if (progress < 90) progress += Math.random() * 3 + 1;
    if (progress > 98) progress = 98;
    bar.style.width = Math.floor(progress) + '%';
    percent.textContent = Math.floor(progress) + '%';
  }, 200);

  const reader = new FileReader();
  reader.onload = async function() {
    const arr = new Uint8Array(reader.result);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < arr.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize));
    }
    const b64 = btoa(binary);
    const payload = { filename: file.name, data: b64 };

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    try {
      const res = await fetch(`/api/upload?scope=${encodeURIComponent(scope)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        credentials: 'same-origin'
      });

      stopped = true;
      clearInterval(interval);

      if (!res.ok) {
        const txt = await res.text().catch(() => 'Ошибка');
        alert('Ошибка загрузки: ' + txt);
        if (t && t.parentNode) t.parentNode.removeChild(t);
        allPhotos = allPhotos.filter(x => x !== previewObj && x.full_url !== previewObj.full_url);
        return;
      }

      const json = await res.json().catch(() => null);

      bar.style.width = '100%';
      percent.textContent = '100%';
      setTimeout(() => {
        if (overlayDiv && overlayDiv.parentNode) overlayDiv.parentNode.removeChild(overlayDiv);
        t.classList.remove('uploading');

        if (json && json.photo) {
          const p = json.photo;
          if (p.id !== undefined && p.id !== null) {
            t.dataset.photoId = String(p.id);
            previewObj.id = p.id;
            previewObj.full_url = p.full_url || ("/images/" + String(p.id));
            previewObj.thumb_url = p.thumb_url || ("/thumbs/" + String(p.id));
            previewObj.orig_name = p.orig_name || previewObj.orig_name;
            if (p.scope) previewObj.scope = p.scope;
          }
          const imgEl = t.querySelector('img');
          if (p.thumb_url) imgEl.src = p.thumb_url;
          if (p.orig_name) imgEl.alt = p.orig_name;
        } else if (json && json.id) {
          const id = json.id;
          t.dataset.photoId = String(id);
          previewObj.id = id;
          previewObj.full_url = "/images/" + String(id);
          previewObj.thumb_url = "/thumbs/" + String(id);
          const imgEl = t.querySelector('img');
          setImageSrcWithAuth(imgEl, ensureThumbUrl(previewObj.thumb_url, previewObj.scope));
        }

        const apIndex = allPhotos.findIndex(x => x === previewObj || (x.full_url === previewObj.full_url && x.id === null));
        if (apIndex !== -1) allPhotos[apIndex] = previewObj;
      }, 300);

    } catch (err) {
      stopped = true;
      clearInterval(interval);
      console.error(err);
      alert('Network error: ' + err.message);
      if (t && t.parentNode) t.parentNode.removeChild(t);
      allPhotos = allPhotos.filter(x => x !== previewObj && x.full_url !== previewObj.full_url);
    } finally {
      try { fileInput.value = ''; } catch (e) {}
      if (pickedText) pickedText.textContent = '';
    }
  };

  reader.onerror = () => {
    stopped = true;
    clearInterval(interval);
    alert('Ошибка чтения файла');
    if (block && block.parentNode) block.parentNode.removeChild(block);
    allPhotos = allPhotos.filter(x => x !== previewObj && x.full_url !== previewObj.full_url);
  };
  reader.readAsArrayBuffer(file);
}

window.addEventListener('scroll', () => {
  if (loading) return;
  if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 600) {
    loadBlocks(loadedBlocks);
  }
});

const menuToggle = document.getElementById('menu-toggle');
const sidebarEl = document.querySelector('.sidebar');
if (menuToggle && sidebarEl) {
  sidebarEl.classList.add('closed-mobile');
  menuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = sidebarEl.classList.contains('open-mobile');
    if (isOpen) {
      sidebarEl.classList.remove('open-mobile');
      sidebarEl.classList.add('closed-mobile');
      menuToggle.setAttribute('aria-expanded', 'false');
    } else {
      sidebarEl.classList.remove('closed-mobile');
      sidebarEl.classList.add('open-mobile');
      menuToggle.setAttribute('aria-expanded', 'true');
    }
  });

  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 900) {
      if (!sidebarEl.contains(e.target) && e.target !== menuToggle && sidebarEl.classList.contains('open-mobile')) {
        sidebarEl.classList.remove('open-mobile');
        sidebarEl.classList.add('closed-mobile');
        menuToggle.setAttribute('aria-expanded', 'false');
      }
    }
  });
}

if (mainEl) {
  ['dragenter','dragover'].forEach(ev => {
    mainEl.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); mainEl.classList.add('drag-over'); });
  });
  ['dragleave','drop'].forEach(ev => {
    mainEl.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); mainEl.classList.remove('drag-over'); });
  });
  mainEl.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const scopeToUse = document.getElementById('scope-select') ? document.getElementById('scope-select').value : currentScope;
    Array.from(dt.files).forEach(f => {
      if (f && f.type && f.type.startsWith('image/')) uploadWithPreview(f, scopeToUse);
    });
  });
}

if (token) {
  showLoggedIn();
} else {
  showLoggedOut();
}
setActiveButton(currentScope);
loadBlocks(0);



/* TOP_PLUS_MODULE_APPENDED */
(function(){
  'use strict';


// --- GLOBAL helpers: setImageSrcWithAuth and ensureThumbUrl (attached to window) ---
(function(){
  // define globally to avoid hoisting/timing issues
  if (!window.setImageSrcWithAuth) {
    window.setImageSrcWithAuth = async function(imgEl, url) {
      if (!imgEl || !url) return;
      // cleanup previous temporary object URL attached to the nearest .thumb
      try {
        const thumbEl = (imgEl.closest && imgEl.closest('.thumb')) ? imgEl.closest('.thumb') : null;
        if (thumbEl && thumbEl.dataset && thumbEl.dataset.previewUrl) {
          try { URL.revokeObjectURL(thumbEl.dataset.previewUrl); } catch(e) {}
          try { delete thumbEl.dataset.previewUrl; } catch(e) {}
        }
      } catch(e){}

      const onErrorHandler = async function() {
        imgEl.onerror = null;
        try {
          const headers = {};
          if (typeof token !== 'undefined' && token) headers['Authorization'] = 'Bearer ' + token;
          const res = await fetch(url, { method: 'GET', headers: headers, credentials: 'same-origin' });
          if (!res.ok) {
            console.warn('setImageSrcWithAuth: fetch failed', res.status, url);
            return;
          }
          const blob = await res.blob();
          const obj = URL.createObjectURL(blob);
          try {
            if (thumbEl) thumbEl.dataset.previewUrl = obj;
            else imgEl.dataset.previewUrl = obj;
          } catch(e){}
          imgEl.src = obj;
        } catch (err) {
          console.error('setImageSrcWithAuth: fetch error', err);
        }
      };

      imgEl.onerror = onErrorHandler;

      try {
        imgEl.src = url;
      } catch(e) {
        imgEl.onerror = null;
        await onErrorHandler();
      }
    };
  }

  if (!window.ensureThumbUrl) {
    window.ensureThumbUrl = function(url, scope) {
      try {
        if (!url) return url;
        if (scope === 'personal') {
          if (typeof token !== 'undefined' && token) {
            return url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(token);
          }
        }
        return url;
      } catch(e) {
        return url;
      }
    };
  }
})();

// --- GLOBAL: tryLoadImageWithRetries ---
(function(){
  if (!window.tryLoadImageWithRetries) {
    window.tryLoadImageWithRetries = async function(imgEl, serverUrl, fallbackUrl, opts) {
      opts = opts || {};
      const maxAttempts = typeof opts.maxAttempts === 'number' ? opts.maxAttempts : 6;
      const initialDelay = typeof opts.initialDelay === 'number' ? opts.initialDelay : 600;
      if (!imgEl) return false;

      // helper: attempt one load and resolve {success:bool}
      const attemptOnce = () => new Promise((resolve) => {
        let settled = false;
        function onLoad() { settled = true; cleanup(); resolve({ success: true }); }
        function onError() { settled = true; cleanup(); resolve({ success: false }); }
        function cleanup() { imgEl.removeEventListener('load', onLoad); imgEl.removeEventListener('error', onError); clearTimeout(timeout); }
        imgEl.addEventListener('load', onLoad);
        imgEl.addEventListener('error', onError);
        try {
          // call auth-aware setter which will try direct then fetch+blob
          window.setImageSrcWithAuth(imgEl, serverUrl);
        } catch (e) {
          // if setter throws synchronously, treat as failure
          cleanup();
          resolve({ success: false });
          return;
        }
        // safety timeout
        const timeout = setTimeout(() => {
          if (!settled) { cleanup(); resolve({ success: false, timeout: true }); }
        }, 5000);
      });

      for (let attempt = 0; attempt < maxAttempts; ++attempt) {
        const res = await attemptOnce();
        if (res && res.success && imgEl.naturalWidth && imgEl.naturalWidth > 0) {
          // loaded successfully from serverUrl; revoke any preview blob attached to nearest .thumb
          try {
            const thumbEl = imgEl.closest && imgEl.closest('.thumb') ? imgEl.closest('.thumb') : null;
            const prev = thumbEl && thumbEl.dataset && thumbEl.dataset.previewUrl ? thumbEl.dataset.previewUrl : null;
            if (prev) { try { URL.revokeObjectURL(prev); } catch(e) {} try { delete thumbEl.dataset.previewUrl; } catch(e) {} }
          } catch(e){}
          return true;
        }
        // set fallback preview URL (if provided)
        try { if (fallbackUrl) imgEl.src = fallbackUrl; } catch(e) {}
        // wait before next attempt (exponential backoff)
        await new Promise(r => setTimeout(r, initialDelay * Math.pow(2, attempt)));
      }
      return false;
    };
  }
})();







// (replaced helper)
if (typeof setImageSrcWithAuth === 'undefined') {
  async function setImageSrcWithAuth(imgEl, url) {
    if (!imgEl || !url) return;
    // cleanup previous temporary object URL attached to the nearest .thumb
    try {
      const thumbEl = imgEl.closest && imgEl.closest('.thumb') ? imgEl.closest('.thumb') : null;
      if (thumbEl && thumbEl.dataset && thumbEl.dataset.previewUrl) {
        try { URL.revokeObjectURL(thumbEl.dataset.previewUrl); } catch(e) {}
        try { delete thumbEl.dataset.previewUrl; } catch(e) {}
      }
    } catch(e){}

    // Attempt direct assignment first
    let attemptedDirect = false;
    const onErrorHandler = async function() {
      imgEl.onerror = null;
      try {
        const headers = {};
        if (typeof token !== 'undefined' && token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(url, { method: 'GET', headers: headers, credentials: 'same-origin' });
        if (!res.ok) {
          // nothing more we can do; leave broken image
          console.warn('setImageSrcWithAuth: fetch failed', res.status, url);
          return;
        }
        const blob = await res.blob();
        const obj = URL.createObjectURL(blob);
        try {
          if (thumbEl) thumbEl.dataset.previewUrl = obj;
          else imgEl.dataset.previewUrl = obj;
        } catch(e){}
        imgEl.src = obj;
      } catch (err) {
        console.error('setImageSrcWithAuth: fetch error', err);
      }
    };

    imgEl.onerror = onErrorHandler;

    try {
      imgEl.src = url;
      attemptedDirect = true;
    } catch(e) {
      imgEl.onerror = null;
      await onErrorHandler();
    }
  }
}

// ensure ensureThumbUrl exists
if (typeof ensureThumbUrl === 'undefined') {
  function ensureThumbUrl(url, scope) {
    try {
      if (!url) return url;
      if (scope === 'personal') {
        if (typeof token !== 'undefined' && token) {
          // if url already has query params, append with &
          return url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(token);
        }
      }
      return url;
    } catch(e) {
      return url;
    }
  }
}



  document.addEventListener('DOMContentLoaded', function(){
    var topPlusBtn = document.getElementById('top-plus');
    var topPlusMenu = document.getElementById('top-plus-menu');
    var topPickBtn = document.getElementById('top-pick-file-btn');
    var topPickedText = document.getElementById('top-file-picked-text');
    var topUploadBtn = document.getElementById('top-upload-btn');
    var fileInput = document.getElementById('file-input');
    if (!topPlusBtn || !topPlusMenu || !fileInput) return;

    // Ensure global flags exist
    window._deferNextFileToTop = window._deferNextFileToTop || false;
    window._topDeferredFiles = window._topDeferredFiles || null;
    window._suppressDocClick = window._suppressDocClick || false;

    // Toggle menu on top-plus click
    topPlusBtn.addEventListener('click', function(e){
      e.stopPropagation();
      if (!topPlusMenu.classList.contains('hidden')) {
        // hide and clear pending selection
        topPlusMenu.classList.add('hidden');
        topPlusMenu.setAttribute('aria-hidden','true');
        topPlusBtn.setAttribute('aria-expanded','false');
        window._topDeferredFiles = null;
        try { fileInput.value = ''; } catch(ex){}
        if (topPickedText) topPickedText.textContent = '';
        if (topUploadBtn) topUploadBtn.classList.add('hidden');
        window._deferNextFileToTop = false;
        window._suppressDocClick = false;
      } else {
        topPlusMenu.classList.remove('hidden');
        topPlusMenu.setAttribute('aria-hidden','false');
        topPlusBtn.setAttribute('aria-expanded','true');
      }
    });

    // prevent clicks inside menu from bubbling (so document click won't close it)
    topPlusMenu.addEventListener('click', function(e){ e.stopPropagation(); });

    // Clicking "Выберите фото" from top menu: set defer flag and open native picker
    if (topPickBtn) {
      topPickBtn.addEventListener('click', function(e){
        e.stopPropagation();
        window._deferNextFileToTop = true;
        window._suppressDocClick = true;
        // safety timeout to clear suppression in case change doesn't fire
        setTimeout(function(){ window._suppressDocClick = false; }, 1200);
        try {
          fileInput.click();
        } catch(err) {
          // fallback: trigger sidebar pick button if exists
          var sidebarPick = document.getElementById('pick-file-btn');
          if (sidebarPick) sidebarPick.click();
        }
      });
    }

    // Upload button in top menu
    if (topUploadBtn) {
      topUploadBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if (!window._topDeferredFiles || !window._topDeferredFiles.length) return;
        var scopeToUse = topPlusMenu.querySelector('input[name=\"tpm-scope\"]:checked') ? topPlusMenu.querySelector('input[name=\"tpm-scope\"]:checked').value : null;
        scopeToUse = scopeToUse || (document.getElementById('scope-select') ? document.getElementById('scope-select').value : null);
        Array.from(window._topDeferredFiles).forEach(function(f){ uploadWithPreview(f, scopeToUse); });
        window._topDeferredFiles = null;
        try { fileInput.value = ''; } catch(ex){}
        if (topPickedText) topPickedText.textContent = '';
        if (topUploadBtn) topUploadBtn.classList.add('hidden');
        topPlusMenu.classList.add('hidden');
        topPlusMenu.setAttribute('aria-hidden','true');
        topPlusBtn.setAttribute('aria-expanded','false');
      });
    }

    // clicking outside closes menu unless suppression active
    document.addEventListener('click', function(){
      if (window._suppressDocClick) { window._suppressDocClick = false; return; }
      if (topPlusMenu && !topPlusMenu.classList.contains('hidden')) {
        topPlusMenu.classList.add('hidden');
        topPlusMenu.setAttribute('aria-hidden','true');
        topPlusBtn.setAttribute('aria-expanded','false');
        window._topDeferredFiles = null;
        try { fileInput.value = ''; } catch(ex){}
        if (topPickedText) topPickedText.textContent = '';
        if (topUploadBtn) topUploadBtn.classList.add('hidden');
        window._deferNextFileToTop = false;
      }
    });
  });
})();
// end TOP_PLUS_MODULE_APPENDED






/* USER_MODAL_MODULE */
(function(){
  'use strict';
  document.addEventListener('DOMContentLoaded', function(){
    var userBtn = document.getElementById('user-btn');
    var userModal = document.getElementById('user-modal');
    var userForm = document.getElementById('user-form');
    var userProfile = document.getElementById('user-profile');
    var loginInput = document.getElementById('user-login-input');
    var passInput = document.getElementById('user-pass-input');
    var loginBtn = document.getElementById('user-login-btn');
    var logoutBtn = document.getElementById('user-logout-btn');
    var userNameEl = document.getElementById('user-name');
    var userError = document.getElementById('user-error');
    var closeBtn = document.getElementById('user-modal-close');

    if (!userBtn || !userModal) return;

    // Keep existing password toggle(s) intact except remove the specific problematic toggle
    try {
      // Remove only the problematic toggle (id 'user-pass-toggle') that showed the monkey 🙈.
      var badToggle = userModal.querySelector('#user-pass-toggle');
      if (badToggle && badToggle.parentNode) badToggle.parentNode.removeChild(badToggle);
      // Do not create a new toggle here — preserve any other existing toggle and its handlers.
    } catch(err) {
      console.error(err);
    }
function isLoggedIn() {
      try { if (typeof token !== 'undefined' && token) return true; } catch(e){}
      return !!localStorage.getItem('jwt');
    }

    function clearProfileView() {
      if (userNameEl) { userNameEl.textContent = ''; }
      if (logoutBtn) { logoutBtn.classList.add('hidden'); }
      if (userProfile) { userProfile.classList.add('hidden'); }
    }

    function showProfile(name) {
      if (userNameEl) userNameEl.textContent = name || '';
      if (userForm) userForm.classList.add('hidden');
      if (userProfile) userProfile.classList.remove('hidden');
      if (logoutBtn) logoutBtn.classList.remove('hidden');
    }

    function showForm() {
      if (userForm) userForm.classList.remove('hidden');
      if (userProfile) userProfile.classList.add('hidden');
      if (userError) { userError.style.display='none'; userError.textContent=''; }
      if (logoutBtn) logoutBtn.classList.add('hidden');
      if (userNameEl) userNameEl.textContent = '';
    }

    function showModal(){
      userModal.classList.remove('hidden');
      userModal.setAttribute('aria-hidden','false');
      if (isLoggedIn()) {
        var uname = '';
        var sidebarUser = document.getElementById('username');
        if (sidebarUser && sidebarUser.value) uname = sidebarUser.value;
        if (!uname) uname = sessionStorage.getItem('user_name') || localStorage.getItem('user_name') || '';
        showProfile(uname);
      } else {
        showForm();
        setTimeout(function(){ if (loginInput) loginInput.focus(); }, 50);
      }
    }
    function hideModal(){
      userModal.classList.add('hidden');
      userModal.setAttribute('aria-hidden','true');
      if (userError) { userError.style.display='none'; userError.textContent=''; }
    }

    // initialize state on load
    if (!isLoggedIn()) {
      showForm();
    } else {
      var name = sessionStorage.getItem('user_name') || localStorage.getItem('user_name') || '';
      showProfile(name);
    }

    userBtn.addEventListener('click', function(e){
      e.stopPropagation();
      if (userModal.classList.contains('hidden')) showModal();
      else hideModal();
    });

    if (closeBtn) closeBtn.addEventListener('click', function(e){ e.stopPropagation(); hideModal(); });

    userModal.addEventListener('click', function(e){
      if (e.target === userModal) hideModal();
    });

    // Prevent modal from being closed when a text selection started inside modal and released outside.
    (function(){
      var mouseDownInside = false;
      userModal.addEventListener('mousedown', function(){ mouseDownInside = true; }, true);
      document.addEventListener('mouseup', function(){ setTimeout(function(){ mouseDownInside = false; }, 0); }, true);
      // capture-phase click handler to stop outside click handlers when selection started inside modal
      document.addEventListener('click', function(e){
        if (mouseDownInside) {
          if (!userModal.contains(e.target)) {
            // prevent other handlers from closing modal
            e.stopImmediatePropagation();
            e.preventDefault();
            // reset flag
            mouseDownInside = false;
          }
        }
      }, true);
    })();

    if (loginBtn) {
      loginBtn.addEventListener('click', async function(e){
        e.preventDefault();
        if (!loginInput || !passInput) return;
        var u = (loginInput.value || '').trim();
        var p = passInput.value || '';
        if (!u || !p) {
          if (userError) { userError.style.display='block'; userError.textContent='Логин и пароль обязательны'; }
          return;
        }
        try {
          var res = await apiPost('/api/login', { username: u, password: p });
          if (res.ok) {
            var j = await res.json();
            token = j.token;
            localStorage.setItem('jwt', token);
            sessionStorage.setItem('user_name', u);
            localStorage.setItem('user_name', u);
            if (typeof showLoggedIn === 'function') showLoggedIn();
            if (typeof resetAndLoad === 'function') resetAndLoad();
            showProfile(u);
            hideModal();
          } else {
            var txt = 'Ошибка входа';
            try { var errj = await res.json(); if (errj && errj.message) txt = errj.message; } catch(e) {}
            if (userError) { userError.style.display='block'; userError.textContent = txt; }
          }
        } catch(err) {
          if (userError) { userError.style.display='block'; userError.textContent = 'Сетевая ошибка'; }
        }
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', function(e){
        e.preventDefault();
        if (typeof showLoggedOut === 'function') showLoggedOut();
        sessionStorage.removeItem('user_name');
        localStorage.removeItem('user_name');
        clearProfileView();
        showForm();
      });
    }

  });
})();
// end USER_MODAL_MODULE





// --- Multi-select feature (added non-invasively via MutationObserver) ---
(function(){
  const blocksEl = document.getElementById('blocks');
  if (!blocksEl) return;
  const header = document.querySelector('.top-strip');
  const brandEl = document.querySelector('.top-brand');
  const topPlus = document.getElementById('top-plus');
  const topGear = document.getElementById('top-gear');
  const userBtn = document.getElementById('user-btn');

  // Create selection UI elements (will be shown/hidden)
  const selectLeft = document.createElement('div');
  selectLeft.className = 'select-mode-left';
  selectLeft.style.display = 'none';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.id = 'select-cancel-btn';
  cancelBtn.className = 'top-btn select-cancel';
  cancelBtn.title = 'Отменить выбор';
  cancelBtn.innerHTML = '&#x2715;'; // simple cross; uses top-btn hover square

  const countLabel = document.createElement('div');
  countLabel.className = 'select-count';
  countLabel.textContent = 'Выбрано: 0';
  selectLeft.appendChild(cancelBtn);
  selectLeft.appendChild(countLabel);

  const selectRight = document.createElement('div');
  selectRight.className = 'select-mode-right';
  selectRight.style.display = 'none';
  const trashBtn = document.createElement('button');
  trashBtn.type = 'button';
  trashBtn.id = 'select-trash-btn';
  trashBtn.className = 'top-btn select-trash';
  trashBtn.title = 'Удалить выбранные';
  // use separate svg file (trash-select.svg) in /icons
  const trashImg = document.createElement('img');
  trashImg.src = '/icons/trash-black.svg';
  trashImg.alt = 'Удалить';
  trashImg.width = 20;
  trashImg.height = 20;
  trashBtn.appendChild(trashImg);
  selectRight.appendChild(trashBtn);

  // append these containers to header (left and right)
  // place left near the left side (replace brand), right near the top-right (replace buttons)
  // Insert select-left *inside* .top-left as first child so it's flush to the left edge
  const tl = header.querySelector('.top-left');
  if (tl) {
    const menuBtn = tl.querySelector('#menu-toggle');
    if (menuBtn && menuBtn.nextSibling) tl.insertBefore(selectLeft, menuBtn.nextSibling);
    else tl.insertBefore(selectLeft, tl.firstChild);
  } else header.insertBefore(selectLeft, header.firstChild);
  // append selectRight into .top-right if present so it sits on the right side
  const tr = header.querySelector('.top-right');
  if (tr) tr.appendChild(selectRight);
  else header.appendChild(selectRight);
  header.appendChild(selectRight);

  let selectedSet = new Set();

  function updateTopStripMode(){
    if (selectedSet.size > 0){
      // hide normal elements
      if (brandEl) brandEl.classList.add('hidden');
      if (topPlus) topPlus.classList.add('hidden');
      if (topGear) topGear.classList.add('hidden');
      if (userBtn) userBtn.classList.add('hidden');
      // show selection UI
      selectLeft.style.display = 'flex';
      selectRight.style.display = 'flex';
      countLabel.textContent = 'Выбрано: ' + selectedSet.size;
    } else {
      // restore
      if (brandEl) brandEl.classList.remove('hidden');
      if (topPlus) topPlus.classList.remove('hidden');
      if (topGear) topGear.classList.remove('hidden');
      if (userBtn) userBtn.classList.remove('hidden');
      selectLeft.style.display = 'none';
      selectRight.style.display = 'none';
      countLabel.textContent = 'Выбрано: 0';
    }
  }

  cancelBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    clearAllSelection();
  });

  trashBtn.addEventListener('click', async (e)=>{
    e.stopPropagation();
    const n = selectedSet.size;
    if (n === 0) return;
    const ok = await showConfirm('Вы уверены что вы хотите удалить ' + n + ' фото?');
    if (!ok) return;
    // delete selected photos sequentially to keep server/load stable
    const ids = Array.from(selectedSet);
    for (const id of ids){
      try {
        const thumb = document.querySelector('.thumb[data-photo-id="'+CSS.escape(String(id))+'"]');
        await deletePhotoByThumb(thumb, id);
      } catch(err){
        console.error('Error deleting',id,err);
      }
    }
    // clear selection
    clearAllSelection();
  });

  function clearAllSelection(){
    selectedSet.clear();
    document.querySelectorAll('.thumb.selected').forEach(el=>{
      el.classList.remove('selected');
      el.dataset.selected = '0';
    });
    updateTopStripMode();
  }

  function toggleThumbSelection(thumbEl){
    if (!thumbEl) return;
    const id = thumbEl.dataset.photoId;
    if (!id) return;
    const key = String(id);
    if (selectedSet.has(key)){
      selectedSet.delete(key);
      thumbEl.classList.remove('selected');
      thumbEl.dataset.selected = '0';
    } else {
      selectedSet.add(key);
      thumbEl.classList.add('selected');
      thumbEl.dataset.selected = '1';
    }
    updateTopStripMode();
  }

  function enhanceThumb(thumb){
    if (!thumb || thumb.dataset.__enhanced) return;
    thumb.dataset.__enhanced = '1';
    // create select bar
    const bar = document.createElement('div');
    bar.className = 'select-bar';
    const btn = document.createElement('button');
    btn.className = 'select-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label','Выбрать фото');
    btn.innerHTML = '<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20 6L9 17l-5-5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>';
    bar.appendChild(btn);
    thumb.appendChild(bar);

    // clicking the select button toggles selection but must not open overlay
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      toggleThumbSelection(thumb);
    });

    // ensure existing click on thumb (which opens overlay) is not triggered when clicking button (we stopped propagation above)
    // nothing else needed

    // when a thumb is removed from DOM, ensure selection cleared
    const obs = new MutationObserver((muts)=>{
      for (const m of muts){
        for (const n of Array.from(m.removedNodes || [])){
          if (n === thumb){
            // removed
            selectedSet.delete(thumb.dataset.photoId);
            updateTopStripMode();
            obs.disconnect();
            return;
          }
        }
      }
    });
    obs.observe(thumb.parentNode || document.body, { childList:true });
  }

  // Enhance existing thumbs
  document.querySelectorAll('.thumb').forEach(enhanceThumb);

  // Watch for new thumbs
  const mo = new MutationObserver((mutations)=>{
    for (const m of mutations){
      if (m.type === 'childList' && m.addedNodes && m.addedNodes.length){
        m.addedNodes.forEach(node=>{
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('thumb')) enhanceThumb(node);
          // also find thumbs inside added subtree (e.g., block -> thumbs -> thumb)
          node.querySelectorAll && node.querySelectorAll('.thumb').forEach(enhanceThumb);
        });
      }
    }
  });
  mo.observe(blocksEl, { childList:true, subtree:true });

  // ensure selection UI updated when page unloads or scope changes
  window.addEventListener('beforeunload', clearAllSelection);
  // if the app triggers resetAndLoad, also clear selection - try to patch that function if available
  try {
    const origReset = window.resetAndLoad;
    if (typeof origReset === 'function'){
      window.resetAndLoad = function(){
        clearAllSelection();
        return origReset.apply(this, arguments);
      };
    }
  } catch(e){}

})();
