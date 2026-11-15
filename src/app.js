// PopoutX — 应用逻辑 / app logic (classic script, shares globals with config.js and i18n.js)
let _tour = null;        // 引导教程的运行状态（放在最前面，避免语言初始化时访问到未初始化的变量）
let _toastBuild = null;  // 当前提示条的生成函数，切换语言时用它重新生成文字
// ---- i18n (中 / EN) ----
let LANG = "en";   // 默认英文；用户切换后会记住选择
try { LANG = localStorage.getItem("xc-lang") === "zh" ? "zh" : "en"; } catch (_) {}
function tr(k, ...a) { const v = (I18N[LANG] && I18N[LANG][k]) ?? I18N.zh[k]; return typeof v === "function" ? v(...a) : v; }
function syncThemeBadge() { const b = document.getElementById("themeModeBadge"); if (b) b.textContent = state.slotTheme === "white" ? tr("white") : tr("black"); }
function applyLang() {
  document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  document.title = tr("title");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = tr(el.dataset.i18nHtml); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = tr(el.dataset.i18nTitle); el.setAttribute("aria-label", tr(el.dataset.i18nTitle)); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", tr(el.dataset.i18nAria)));
  syncThemeBadge();
  // 已经弹出来的内容也要跟着换语言：提示条、教程卡片
  const tEl = document.getElementById("toast");
  if (_toastBuild && tEl.classList.contains("show")) tEl.textContent = _toastBuild();
  if (typeof _tour !== "undefined" && _tour) tourRefreshText();
  const ws = document.getElementById("slotsCountVal");
  if (ws) ws.textContent = tr("slicesVal", Number(document.getElementById("slotsCount").value));
  if (typeof updateFlow === "function") updateFlow();
  if (typeof state !== "undefined" && state.source && typeof render === "function") render();
}
function setLang(l) { LANG = l; try { localStorage.setItem("xc-lang", l); } catch (_) {} applyLang(); }

// --- State Definition ---
const MAX_LONG = 2000;

const state = {
  source: null,         // HTMLCanvasElement (original image)
  rawAiProbMask: null,  // Float32Array or ImageData for dynamic thresholding
  maskCanvas: null,     // HTMLCanvasElement (strictly 100% white = subject, 0 = bg)
  compositeCanvas: null,// HTMLCanvasElement (themed: black, white, or transparent)
  compositeTransparentCanvas: null, // HTMLCanvasElement (strictly binary alpha: 0 or 255)
  
  // Slices & 3D Focal Page (1 to 20 images)
  sliceCount: 10,       // 整图先等分成多少列 (1~20)
  focalSpan: 10,        // 3D 主图占几列宽 (= 整图列数时为"全图合成")
  lineKeepCanvas: null, // 手工擦掉线段的区域 (白=不要线)
  hasRegion: false,     // 有主体时才存在 3D 图
  regionL: 0, regionR: 1, // 3D 图范围 (自动, 占整图宽度的比例)
  subjectBox: null,
  selectedSlot: -1,     // 当前选中的分隔线
  sliceRatioMode: "even", // 'even' (等宽百叶窗) or 'focal' (焦点加宽)
  focalSliceIndex: 0,   // 主图起始列 (= 合并后的第几张, 0-indexed)

  // Slots (inside 3D focal page) - locked to X native parameters
  slotTheme: "black",   // 'black' (深色), 'white' (浅色), 'transparent' (透明通道)
  slotsCount: 9,
  centers: [],          // relative 0..1 coordinates within 3D focal slice
  activeDragSlot: -1,

  // Tool
  tool: "move",         // 'move', 'paint', 'erase', 'ellipse'
  brushSize: 45,
  isPainting: false,
  ellipseStart: null,

  // Display
  theme: "dark",
  showMaskOverlay: false,
  
  isAiProcessing: false,
};

// History for Undo / Redo
const historyStack = [];

function cloneMaskCanvas(source) {
  if (!source) return null;
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  c.getContext("2d").drawImage(source, 0, 0);
  return c;
}

function snapshotNow(name) {
  return {
    mask: cloneMaskCanvas(state.maskCanvas),
    lineKeep: cloneMaskCanvas(state.lineKeepCanvas),
    centers: [...state.centers],
    regionL: state.regionL,
    regionR: state.regionR,
    slotsCount: state.slotsCount,
    slotTheme: state.slotTheme,
    focalSliceIndex: state.focalSliceIndex,
    sliceCount: state.sliceCount,
    focalSpan: state.focalSpan,
    name: name,
  };
}
// 历史 = 每一步修改"之后"的状态；histIdx 指向当前状态
let histIdx = -1;
function pushHistory(name = "action") {
  if (!state.maskCanvas) return;
  historyStack.length = histIdx + 1;          // 丢掉被撤销的"未来"
  historyStack.push(snapshotNow(name));
  if (historyStack.length > 30) historyStack.shift();
  histIdx = historyStack.length - 1;
  updateHistoryButtons();
  if (typeof scheduleSave === "function") scheduleSave();
}
function resetHistory() { historyStack.length = 0; histIdx = -1; updateHistoryButtons(); }
function undo() {
  if (histIdx <= 0) return;
  histIdx--;
  applySnapshot(historyStack[histIdx]);
  updateHistoryButtons();
  render();
}
function redo() {
  if (histIdx >= historyStack.length - 1) return;
  histIdx++;
  applySnapshot(historyStack[histIdx]);
  updateHistoryButtons();
  render();
}

function applySnapshot(snap) {
  if (snap.mask) {
    state.maskCanvas.getContext("2d").clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    state.maskCanvas.getContext("2d").drawImage(snap.mask, 0, 0);
  }
  if (state.source) {
    const lk = ensureLineKeep().getContext("2d");
    lk.clearRect(0, 0, state.lineKeepCanvas.width, state.lineKeepCanvas.height);
    if (snap.lineKeep) lk.drawImage(snap.lineKeep, 0, 0);
  }
  state.centers = [...snap.centers];
  if (snap.regionL !== undefined) { state.regionL = snap.regionL; state.regionR = snap.regionR; }
  state.slotsCount = snap.slotsCount || 3;
  state.focalSliceIndex = snap.focalSliceIndex || 0;
  state.sliceCount = snap.sliceCount || 10;
  state.focalSpan = snap.focalSpan || state.focalSpan;
  state.slotTheme = snap.slotTheme === "white" ? "white" : "black";

  syncLineCount();
  syncThemeBadge();

  document.querySelectorAll("#slotThemeSegGroup .seg-item").forEach((b) => {
    const isAct = b.dataset.slotTheme === state.slotTheme;
    b.classList.toggle("active", isAct);
    b.setAttribute("aria-pressed", String(isAct));
  });

  const sliceSlider = document.getElementById("slicesCountSlider");
  if (sliceSlider) {
    sliceSlider.value = String(state.sliceCount);
    document.getElementById("slicesCountVal").textContent = tr("slicesVal", state.sliceCount);
  }
  document.querySelectorAll("#sliceCountPills .preset-pill").forEach((pill) => {
    pill.classList.toggle("active", Number(pill.dataset.count) === state.sliceCount);
  });
  if (typeof syncSpanUi === "function") syncSpanUi();
}

function updateHistoryButtons() {
  document.getElementById("btnUndo").disabled = (histIdx <= 0);
  document.getElementById("btnRedo").disabled = (histIdx >= historyStack.length - 1);
}

// DOM elements
const mainCanvas = document.getElementById("mainCanvas");
const ctx = mainCanvas.getContext("2d");
const emptyDropzone = document.getElementById("emptyDropzone");
const fileInput = document.getElementById("fileInput");
const slicesContainer = document.getElementById("slicesContainer");
const brushIndicator = document.getElementById("brushIndicator");
const loadingModal = document.getElementById("loadingModal");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// Generate default relative centers for slots inside 3D slice
function generateSliceCenters(count, mode = "even") {
  const centers = [];
  if (count < 1) return [];
  if (mode === "centerHole") {
    const leftCount = Math.floor(count / 2);
    const rightCount = count - leftCount;
    for (let i = 0; i < leftCount; i++) {
      centers.push(0.10 + (0.30 * i) / Math.max(1, leftCount - 1));
    }
    for (let i = 0; i < rightCount; i++) {
      centers.push(0.60 + (0.30 * i) / Math.max(1, rightCount - 1));
    }
    return centers.sort((a,b) => a - b);
  }
  // 槽位落在 count+1 根立柱的分界处, 立柱等宽 (与旁边普通切片节奏一致)
  for (let i = 1; i <= count; i++) centers.push(i / (count + 1));
  return centers;
}

(function initDefaults() {
  state.centers = [];
  for (let i = 1; i < 10; i++) state.centers.push(i / 10);   // 10 张普通切片
})();

// 线不完整（被擦掉，或被主体盖住）就不再是切口，左右两张图合并成一张；用「恢复」补完整后再次分开
state.mergedIdx = new Set();
function effCenters() { return state.centers.filter((_, i) => !state.mergedIdx.has(i)); }
function computeMerged(w, h) {
  // 一条缝要"完整"：整条都可见——既没被擦掉，也没被主体盖住（除非用"恢复"补回）。不完整就不再是切口。
  const merged = new Set();
  const lkCtx = state.lineKeepCanvas && state.lineKeepCanvas.width === w && state.lineKeepCanvas.height === h ? state.lineKeepCanvas.getContext("2d") : null;
  const mkCtx = state.maskCanvas && state.maskCanvas.width === w && state.maskCanvas.height === h ? state.maskCanvas.getContext("2d") : null;
  state.centers.forEach((c, i) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(c * w)));
    const lk = lkCtx ? lkCtx.getImageData(x, 0, 1, h).data : null;
    const mk = mkCtx ? mkCtx.getImageData(x, 0, 1, h).data : null;
    let missing = 0;
    for (let y = 0; y < h; y++) {
      const k = y * 4;
      const marked = lk && lk[k + 3] > 100;
      const erased = marked && lk[k + 1] > 200;
      const forced = marked && lk[k + 1] <= 200;
      const covered = mk && (mk[k] > 100 || mk[k + 3] > 100);
      if (erased || (covered && !forced)) missing++;
    }
    if (missing / h >= 0.02) merged.add(i);
  });
  limitMainWidth(merged, w, h);
  state.mergedIdx = merged;
}
// X 的多图格子宽高比上限约 0.64（实测：网页版超出会被压扁，手机版超出会被裁掉两边）。
// 主图（被主体盖住而连在一起的那组列）超过这个宽度时，只保留主体最多的一段窗口作为主图，
// 窗口之外的缝恢复成普通切口，那部分主体和普通切片一样被切开。原图不裁剪、不补边。
const X_MAX_ASPECT = 0.64;
function limitMainWidth(merged, w, h) {
  const cols = state.subjectCols;
  if (!cols || !state.subjectBox || cols.length !== w) return;
  const budget = Math.floor(X_MAX_ASPECT * h * 0.985);
  const edges = [0, ...state.centers.map((c) => Math.min(w, Math.max(0, Math.round(c * w)))), w];
  const n = edges.length - 1;
  const colSum = (i) => { let t = 0; for (let x = edges[i]; x < edges[i + 1]; x++) if (cols[x] >= 3) t += cols[x]; return t; };
  const groups = [];
  let start = 0;
  for (let k = 0; k < state.centers.length; k++) if (!merged.has(k)) { groups.push([start, k]); start = k + 1; }
  groups.push([start, n - 1]);
  let g = null, gSum = 0;
  for (const gr of groups) { let t = 0; for (let i = gr[0]; i <= gr[1]; i++) t += colSum(i); if (t > gSum) { gSum = t; g = gr; } }
  if (!g || g[0] === g[1] || edges[g[1] + 1] - edges[g[0]] <= budget) return;
  let best = null, bestSum = -1;
  for (let i = g[0]; i <= g[1]; i++) {
    let t = 0;
    for (let j = i; j <= g[1]; j++) {
      if (edges[j + 1] - edges[i] > budget) break;
      t += colSum(j);
      if (t > bestSum) { bestSum = t; best = [i, j]; }
    }
  }
  for (let k = g[0]; k < g[1]; k++) merged.delete(k);          // 先全部恢复成切口
  if (best) for (let k = best[0]; k < best[1]; k++) merged.add(k);   // 再只把窗口内的缝并起来
}
function sortedCuts(totalWidth) {
  const xs = effCenters().map((c) => Math.round(c * totalWidth)).filter((x) => x > 0 && x < totalWidth).sort((a, b) => a - b);
  return [...new Set(xs)];
}
function getSliceParts(totalWidth) {
  const cuts = [0, ...sortedCuts(totalWidth), totalWidth];
  return cuts.slice(1).map((c, i) => c - cuts[i]);
}

// ---- 3D 图范围 (红框)：左右边界吸附在缝上；框内的缝烘焙成槽，框外的缝只是切口 ----
function cutFracs() {
  const xs = [...new Set(effCenters().map((c) => Math.round(c * 10000) / 10000))].filter((x) => x > 0 && x < 1).sort((a, b) => a - b);
  return [0, ...xs, 1];
}
function autoRegion() {
  // 主图 = 被「不完整的缝」连在一起的那一组列里，主体最多的一组。补完整的缝会把组拆开，
  // 主体只占一小角的那一边就变回普通切片（不依赖抠图边界是否精准）。
  const cols = state.subjectCols;
  if (!state.subjectBox || !cols) { state.hasRegion = false; return; }
  const w = cols.length;
  const cf = cutFracs();
  let best = -1, bestSum = 0;
  for (let i = 0; i < cf.length - 1; i++) {
    const a = Math.round(cf[i] * w), b = Math.round(cf[i + 1] * w);
    let s = 0;
    for (let x = a; x < b; x++) if (cols[x] >= 3) s += cols[x];
    if (s > bestSum) { bestSum = s; best = i; }
  }
  if (best < 0 || bestSum < 20) { state.hasRegion = false; return; }
  state.hasRegion = true;
  state.regionL = cf[best];
  state.regionR = cf[best + 1];
}
function normalizeRegion() { autoRegion(); }
function isInner(c) { return state.hasRegion && c > state.regionL + 2e-4 && c < state.regionR - 2e-4; }
function regionPieces() {
  if (!state.hasRegion) return 0;
  return cutFracs().filter((c) => c >= state.regionL - 2e-4 && c <= state.regionR + 2e-4).length - 1;
}
function imageCount() { return (cutFracs().length - 1) - regionPieces() + (state.hasRegion ? 1 : 0); }
function exportLayout(w) {
  const cuts = cutFracs().map((f) => Math.round(f * w));
  const L = Math.round(state.regionL * w), R = Math.round(state.regionR * w);
  const out = [];
  let done = false;
  if (!state.hasRegion) {
    for (let i = 0; i < cuts.length - 1; i++) out.push({ x0: cuts[i], x1: cuts[i + 1], kind: "plain" });
    return out;
  }
  for (let i = 0; i < cuts.length - 1; i++) {
    const x0 = cuts[i], x1 = cuts[i + 1];
    if (x0 >= L && x1 <= R) {
      if (!done) { out.push({ x0: L, x1: R, kind: "3d" }); done = true; }
    } else {
      out.push({ x0, x1, kind: "plain" });
    }
  }
  return out;
}
// 按"切片图片数量 n"和 3D 图占 m 列, 均匀重排所有缝
function applyImageCount(n) {
  n = Math.max(1, Math.min(20, n));
  state.centers = [];
  for (let i = 1; i < n; i++) state.centers.push(i / n);   // 等分成 n 列
  autoRegion();
  state.selectedSlot = -1;
  syncLineCount();
}

// X 图间缝宽 / 槽宽 / 圆角, 随图片宽度等比
function slotMetrics(w) {
  // 槽宽 = X 平台图间缝宽 (参考帖截图实测: 9px / 1282px = 0.70%), 与旁边切片之间的缝一致
  const gap = Math.max(4, Math.round(w * 0.007));
  const slotW = gap;
  const cuts = [0, ...sortedCuts(w), w];
  let minPillar = w;
  for (let i = 1; i < cuts.length; i++) minPillar = Math.min(minPillar, cuts[i] - cuts[i - 1] - slotW);
  const R = Math.max(2, Math.min(Math.round(w * 0.0062), Math.floor(Math.max(4, minPillar) / 2)));
  return { gap, slotW, R };
}

// X-native slot geometry (rounded capsule gaps between images)
// Exactly replicates two adjacent X image cards (border-radius: 8px, 1px border, native gap):
function punchSlotTwitter(cCtx, cx, h, slotW, R) {
  const halfGap = slotW / 2;

  cCtx.beginPath();
  // 1. Top-right notch (from y=0 to y=R)
  for (let y = 0; y <= R; y += 1) {
    const arcX = R - Math.sqrt(Math.max(0, R * R - (R - y) * (R - y)));
    const hw = halfGap + arcX;
    if (y === 0) cCtx.moveTo(cx + hw, y);
    else cCtx.lineTo(cx + hw, y);
  }
  // 2. Right straight shaft
  cCtx.lineTo(cx + halfGap, h - R);
  // 3. Bottom-right notch (from y=h-R to y=h)
  for (let y = h - R; y <= h; y += 1) {
    const dy = y - (h - R);
    const arcX = R - Math.sqrt(Math.max(0, R * R - dy * dy));
    const hw = halfGap + arcX;
    cCtx.lineTo(cx + hw, y);
  }
  // 4. Bottom-left notch (from y=h to y=h-R)
  for (let y = h; y >= h - R; y -= 1) {
    const dy = y - (h - R);
    const arcX = R - Math.sqrt(Math.max(0, R * R - dy * dy));
    const hw = halfGap + arcX;
    cCtx.lineTo(cx - hw, y);
  }
  // 5. Left straight shaft
  cCtx.lineTo(cx - halfGap, R);
  // 6. Top-left notch (from y=R to y=0)
  for (let y = R; y >= 0; y -= 1) {
    const arcX = R - Math.sqrt(Math.max(0, R * R - (R - y) * (R - y)));
    const hw = halfGap + arcX;
    cCtx.lineTo(cx - hw, y);
  }
  cCtx.closePath();
  cCtx.fill();
}

function fitSource(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const longSide = Math.max(w, h);
  const scale = longSide > MAX_LONG ? MAX_LONG / longSide : 1;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const cCtx = c.getContext("2d");
  cCtx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Master Render Pipeline:
// 1. "只有做了伪 3D 效果的页面是一张，其他都要单独生成切片"
// 2. "要么透 要么不透" -> Alpha 严格只能是 0 (纯透) 或 255 (纯实心)，绝不出现半透明脏边！
// 3. 锁定 X 平台固定参数，仅根据推特模式选择黑色或白色
function render() {
  if (!state.source) return;
  const w = state.source.width;
  const h = state.source.height;

  if (!state.maskCanvas || state.maskCanvas.width !== w || state.maskCanvas.height !== h) {
    const mc = document.createElement("canvas");
    mc.width = w;
    mc.height = h;
    state.maskCanvas = mc;
  }

  computeMerged(w, h);
  normalizeRegion();
  const widths = getSliceParts(w);
  const lineInfo = document.getElementById("lineCountInfo");
  if (lineInfo) lineInfo.textContent = `${imageCount()} 张图`;

  // --- Step 1: Extract Source Pixels ---
  const srcCtx = state.source.getContext("2d");
  const srcData = srcCtx.getImageData(0, 0, w, h).data;

  // --- Step 2: Extract Mask Pixels (Enforce STRICT Binary: 0 or 255) ---
  const maskCtx = state.maskCanvas.getContext("2d");
  const rawMaskData = maskCtx.getImageData(0, 0, w, h).data;
  const maskBin = new Uint8Array(w * h);
  for (let i = 0; i < maskBin.length; i++) {
    // If user painted or selected, anything > 100 is solid subject
    maskBin[i] = (rawMaskData[i * 4] > 100 || rawMaskData[i * 4 + 3] > 100) ? 255 : 0;
  }

  // 主体横向范围 (忽略零星噪点)
  {
    const col = new Uint32Array(w);
    for (let i = 0; i < maskBin.length; i++) if (maskBin[i] === 255) col[i % w]++;
    let x0 = -1, x1 = -1;
    for (let x = 0; x < w; x++) if (col[x] >= 3) { if (x0 < 0) x0 = x; x1 = x; }
    state.subjectBox = x0 >= 0 ? { x0: x0 / w, x1: (x1 + 1) / w } : null;
    state.subjectCols = col;
    autoRegion();
  }

  // --- Step 3: Draw Slots Mask inside 3D Focal Slice (X Native Geometry) ---
  const slotsCanvas = document.createElement("canvas");
  slotsCanvas.width = w;
  slotsCanvas.height = h;
  const sCtx = slotsCanvas.getContext("2d");
  sCtx.fillStyle = "#ffffff";

  const { slotW, R: slotR } = slotMetrics(w);
  for (const centerRatio of state.centers.filter(isInner)) {   // 主图范围内的线保留（含局部擦除的），按擦除蒙版显示
    punchSlotTwitter(sCtx, centerRatio * w, h, slotW, slotR);
  }
  const rawSlotsData = sCtx.getImageData(0, 0, w, h).data;
  const lkData = state.lineKeepCanvas ? state.lineKeepCanvas.getContext("2d").getImageData(0, 0, w, h).data : null;
  const slotsBin = new Uint8Array(w * h);   // 0 无槽 / 255 槽 / 2 强制还原的槽
  const slotCov = new Uint8Array(w * h);    // 槽的边缘覆盖率 0..255 (抗锯齿)
  for (let i = 0; i < slotsBin.length; i++) {
    // lineKeep 画布：白 = 手工擦掉的线；红 = 强制还原的线（连主体盖住的部分也显示）
    const lk = lkData && lkData[i * 4 + 3] > 100 ? lkData[i * 4 + 1] : -1;
    const erased = lk > 200;
    const forced = lk >= 0 && lk <= 200;
    const cov = erased ? 0 : rawSlotsData[i * 4 + 3];
    slotCov[i] = cov;
    slotsBin[i] = cov > 0 ? ((forced && cov >= 128) ? 2 : 255) : 0;
  }

  // --- Step 4: Master Themed Composite Assembly: STRICT "要么透(0) 要么不透(255)" (NO SHADOW!) ---
  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d");
  const outImgData = outCtx.createImageData(w, h);
  const dst = outImgData.data;

  // Master Transparent Composite (Alpha=0 at slots) for universal PNG export
  const transCanvas = document.createElement("canvas");
  transCanvas.width = w;
  transCanvas.height = h;
  const transCtx = transCanvas.getContext("2d");
  const transImgData = transCtx.createImageData(w, h);
  const tDst = transImgData.data;

  // 主体边缘羽化（仅黑/白底色：主体压在竖槽上的 1px 边缘做柔和过渡；透明底保持纯 0/255）
  const feather = state.slotTheme !== "transparent";
  const themeC = state.slotTheme === "white" ? 255 : 0;
  let subCov = null;
  if (feather) {
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const ro = y * w;
      for (let x = 0; x < w; x++) {
        const a = x > 0 ? maskBin[ro + x - 1] : maskBin[ro + x];
        const c = x < w - 1 ? maskBin[ro + x + 1] : maskBin[ro + x];
        tmp[ro + x] = ((a + maskBin[ro + x] + c) / 255) | 0;
      }
    }
    subCov = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ro = y * w, up = (y > 0 ? y - 1 : y) * w, dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) subCov[ro + x] = (tmp[up + x] + tmp[ro + x] + tmp[dn + x]) / 9;
    }
  }

  for (let i = 0; i < maskBin.length; i++) {
    const px = i * 4;
    const isSlot = (slotsBin[i] !== 0);
    const isSubject = (maskBin[i] === 255) && slotsBin[i] !== 2;  // 强制还原的线盖在主体前面

    const r = srcData[px];
    const g = srcData[px + 1];
    const b = srcData[px + 2];

    if (isSubject) {
      // 1. 焦点主体：100% 纯实心，完全不透！原色原画质，绝无阴影干扰！
      const sc = feather ? subCov[i] : 1;
      if (feather && sc < 1 && slotCov[i] > 0) {
        // 边缘压在竖槽上：与槽色柔和过渡
        const sl = slotCov[i] / 255;
        dst[px] = r * sc + (r + (themeC - r) * sl) * (1 - sc);
        dst[px + 1] = g * sc + (g + (themeC - g) * sl) * (1 - sc);
        dst[px + 2] = b * sc + (b + (themeC - b) * sl) * (1 - sc);
      } else {
        dst[px] = r;
        dst[px + 1] = g;
        dst[px + 2] = b;
      }
      dst[px + 3] = 255;

      tDst[px] = r;
      tDst[px + 1] = g;
      tDst[px + 2] = b;
      tDst[px + 3] = 255;
    } else if (isSlot) {
      // 2. 胶囊竖槽：边缘按覆盖率与原图混合 (抗锯齿)；透明镂空主图保持 0/255 二值
      const cov = slotCov[i] / 255;
      if (state.slotTheme === "transparent") {
        if (cov >= 0.5) { dst[px] = dst[px + 1] = dst[px + 2] = dst[px + 3] = 0; }
        else { dst[px] = r; dst[px + 1] = g; dst[px + 2] = b; dst[px + 3] = 255; }
      } else {
        const c = state.slotTheme === "white" ? 255 : 0;
        let o0 = r + (c - r) * cov, o1 = g + (c - g) * cov, o2 = b + (c - b) * cov;
        const sc = (feather && slotsBin[i] !== 2) ? subCov[i] : 0;
        if (sc > 0) { o0 = r * sc + o0 * (1 - sc); o1 = g * sc + o1 * (1 - sc); o2 = b * sc + o2 * (1 - sc); }
        dst[px] = o0; dst[px + 1] = o1; dst[px + 2] = o2;
        dst[px + 3] = 255;
      }

      // Transparent master: 严格纯透明镂空
      if (slotCov[i] >= 128) {
        tDst[px] = 0; tDst[px + 1] = 0; tDst[px + 2] = 0; tDst[px + 3] = 0;
      } else {
        tDst[px] = r; tDst[px + 1] = g; tDst[px + 2] = b; tDst[px + 3] = 255;
      }
    } else {
      // 3. 背景区域：100% 纯实心，原画清晰！
      dst[px] = r;
      dst[px + 1] = g;
      dst[px + 2] = b;
      dst[px + 3] = 255;

      tDst[px] = r;
      tDst[px + 1] = g;
      tDst[px + 2] = b;
      tDst[px + 3] = 255;
    }
  }

  outCtx.putImageData(outImgData, 0, 0);
  transCtx.putImageData(transImgData, 0, 0);
  state.compositeCanvas = outCanvas;
  state.compositeTransparentCanvas = transCanvas;

  // 仅用于编辑器显示：框外的缝画成间隙 (不进入导出)
  const viewCanvas = document.createElement("canvas");
  viewCanvas.width = w;
  viewCanvas.height = h;
  const vctx = viewCanvas.getContext("2d");
  vctx.drawImage(outCanvas, 0, 0);
  const outerC = effCenters().filter((c) => !isInner(c));
  if (outerC.length) {
    const oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    const octx = oc.getContext("2d");
    octx.fillStyle = "#fff";
    for (const c of outerC) punchSlotTwitter(octx, c * w, h, slotW, slotR);
    const od = octx.getImageData(0, 0, w, h).data;
    const vd = vctx.getImageData(0, 0, w, h);
    for (let i = 0; i < maskBin.length; i++) {
      const cv = od[i * 4 + 3] / 255;
      const erasedHere = lkData && lkData[i * 4 + 3] > 100 && lkData[i * 4 + 1] > 200;
      if (cv > 0 && !erasedHere) {   // 普通切片之间的缝一律画出（补完整的缝会穿过主体边缘）
        const k = i * 4;
        if (state.slotTheme === "transparent") {
          if (cv >= 0.5) vd.data[k] = vd.data[k + 1] = vd.data[k + 2] = vd.data[k + 3] = 0;
        } else {
          const c = state.slotTheme === "white" ? 255 : 0;
          vd.data[k] += (c - vd.data[k]) * cv;
          vd.data[k + 1] += (c - vd.data[k + 1]) * cv;
          vd.data[k + 2] += (c - vd.data[k + 2]) * cv;
        }
      }
    }
    vctx.putImageData(vd, 0, 0);
  }

  // --- Step 5: Display on Main Canvas (with Twitter gap simulation) ---
  mainCanvas.hidden = false;
  emptyDropzone.hidden = true;

  const gapPx = 0;
  const totalDisplayW = w + (widths.length - 1) * gapPx;
  // 预览分辨率：原图比屏幕物理像素小时放大绘制（高清屏不再糊），导出不受影响
  const cssW = mediaWrap.clientWidth || 570;
  const viewK = Math.min(4, Math.max(1, Math.ceil((cssW * (window.devicePixelRatio || 1)) / totalDisplayW)));
  state.viewScale = viewK;
  mainCanvas.width = Math.round(totalDisplayW * viewK);
  mainCanvas.height = Math.round(h * viewK);
  ctx.setTransform(viewK, 0, 0, viewK, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, totalDisplayW, h);

  ctx.drawImage(viewCanvas, 0, 0);

  // --- Step 7: Draw Overlays ---
  if (state.showMaskOverlay && !state.peek && state.tool !== "move") {
    // 修蒙版时：只画细红边 + 很淡的底色，图片效果仍然看得清；按住空格可完全隐藏
    const t = Math.max(1, Math.round((1.6 * w) / (mainCanvas.getBoundingClientRect().width || w)));
    const rowPre = new Int32Array(w + 1);
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const ro = y * w;
      for (let x = 0; x < w; x++) rowPre[x + 1] = rowPre[x] + (maskBin[ro + x] ? 1 : 0);
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, x - t), b = Math.min(w - 1, x + t);
        tmp[ro + x] = (rowPre[b + 1] - rowPre[a] === b - a + 1 && x - t >= 0 && x + t < w) ? 1 : 0;
      }
    }
    const img = ctx.createImageData(w, h);
    const colPre = new Int32Array(h + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) colPre[y + 1] = colPre[y] + tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (!maskBin[i]) continue;
        const a = Math.max(0, y - t), b = Math.min(h - 1, y + t);
        const inner = (colPre[b + 1] - colPre[a] === b - a + 1 && y - t >= 0 && y + t < h);
        const k = i * 4;
        img.data[k] = 255; img.data[k + 1] = 45; img.data[k + 2] = 85;
        img.data[k + 3] = inner ? 38 : 235;
      }
    }
    const oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    oc.getContext("2d").putImageData(img, 0, 0);
    ctx.drawImage(oc, 0, 0);
  } else if (state.showMaskOverlay && !state.peek) {
    ctx.save();
    let sX = 0;
    let dX = 0;
    for (let i = 0; i < widths.length; i++) {
      const sw = widths[i];
      const overlay = document.createElement("canvas");
      overlay.width = sw;
      overlay.height = h;
      const oCtx = overlay.getContext("2d");
      oCtx.drawImage(state.maskCanvas, sX, 0, sw, h, 0, 0, sw, h);
      oCtx.globalCompositeOperation = "source-in";
      oCtx.fillStyle = "rgba(255, 45, 85, 0.45)";
      oCtx.fillRect(0, 0, sw, h);

      ctx.drawImage(overlay, dX, 0);
      sX += sw;
      dX += sw + gapPx;
    }
    ctx.restore();
  }

  // Live Ellipse Preview while Dragging
  if (state.tool === "ellipse" && state.ellipseStart && state.ellipseCurrent) {
    ctx.save();
    const cx = (state.ellipseStart.x + state.ellipseCurrent.x) / 2;
    const cy = (state.ellipseStart.y + state.ellipseCurrent.y) / 2;
    const rx = Math.abs(state.ellipseCurrent.x - state.ellipseStart.x) / 2;
    const ry = Math.abs(state.ellipseCurrent.y - state.ellipseStart.y) / 2;
    const dispCx = cx + sortedCuts(w).filter((x) => x < cx).length * gapPx;
    ctx.strokeStyle = "#1d9bf0";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 4]);
    ctx.fillStyle = "rgba(29, 155, 240, 0.25)";
    ctx.beginPath();
    ctx.ellipse(dispCx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  updateSlicesStrip(exportLayout(w));
  updateWideHint(w, h);
  document.getElementById("btnDownload").disabled = false;
  statusText.textContent = tr("statusCount", imageCount(), state.hasRegion);
  if (typeof updateFlow === "function") updateFlow();
  statusDot.className = "status-dot";
}

// 任何一张图比 X 允许的更宽（份数太少时每张都很宽）就提醒：X 会把它压扁或裁掉两边
function updateWideHint(w, h) {
  const el = document.getElementById("wideHint");
  if (!el) return;
  const widest = Math.max(...exportLayout(w).map((it) => it.x1 - it.x0));
  el.hidden = widest / h <= X_MAX_ASPECT;
  if (!el.hidden) el.textContent = tr("wideHint", Math.ceil(w / (X_MAX_ASPECT * h * 0.985)));
}

// Slices Strip UI Update
function updateSlicesStrip(layout) {
  slicesContainer.replaceChildren();
  if (!state.compositeCanvas) return;
  const comp = state.compositeCanvas;
  const h = comp.height;
  layout.forEach((it, index) => {
    const width = it.x1 - it.x0;
    const is3d = it.kind === "3d";
    const card = document.createElement("div");
    card.className = `slice-card ${is3d ? "is-3d-focal" : ""}`;
    const thumbCanvas = document.createElement("canvas");
    const targetH = 60;
    const scale = targetH / h;
    thumbCanvas.width = Math.max(1, Math.round(width * scale));
    thumbCanvas.height = targetH;
    thumbCanvas.className = "slice-thumb-canvas";
    thumbCanvas.getContext("2d").drawImage(is3d ? comp : state.source, it.x0, 0, width, h, 0, 0, thumbCanvas.width, targetH);
    const info = document.createElement("div");
    info.className = "slice-info";
    info.textContent = `${String(index + 1).padStart(2, "0")}` + (is3d ? tr("mainTag") : "");
    card.append(thumbCanvas, info);
    slicesContainer.append(card);
  });
}

// Morphological edge smoothing & anti-aliasing refiner (Strict Binary 0 or 255)
function smoothBinaryMask(maskBin, w, h, radius = 2) {
  const temp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  const winSize = 2 * radius + 1;

  // Horizontal box blur
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = Math.max(0, Math.min(w - 1, k));
      sum += maskBin[rowOffset + x];
    }
    for (let x = 0; x < w; x++) {
      temp[rowOffset + x] = sum / winSize;
      const xOld = Math.max(0, x - radius);
      const xNew = Math.min(w - 1, x + radius + 1);
      sum += maskBin[rowOffset + xNew] - maskBin[rowOffset + xOld];
    }
  }

  // Vertical box blur + Strict Binarization (120 threshold)
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = Math.max(0, Math.min(h - 1, k));
      sum += temp[y * w + x];
    }
    for (let y = 0; y < h; y++) {
      const avg = sum / winSize;
      out[y * w + x] = avg >= 120 ? 255 : 0; // "要么透 要么不透"
      const yOld = Math.max(0, y - radius);
      const yNew = Math.min(h - 1, y + radius + 1);
      sum += temp[yNew * w + x] - temp[yOld * w + x];
    }
  }
  return out;
}

// Check and automatically extract transparency from uploaded image (Zero waiting, 100% precision)
function checkAndExtractTransparency(sourceCanvas) {
  if (!sourceCanvas) return false;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const sCtx = sourceCanvas.getContext("2d");
  const data = sCtx.getImageData(0, 0, w, h).data;
  
  let transparentCount = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 240) transparentCount++;
  }
  
  // If at least 0.5% of pixels are transparent, it's a transparent image!
  if (transparentCount > (w * h) * 0.005) {
    const mCtx = state.maskCanvas.getContext("2d");
    const mData = mCtx.createImageData(w, h);
    const mDst = mData.data;
    for (let i = 0; i < w * h; i++) {
      const a = data[i * 4 + 3];
      if (a > 100) {
        mDst[i * 4] = 255;
        mDst[i * 4 + 1] = 255;
        mDst[i * 4 + 2] = 255;
        mDst[i * 4 + 3] = 255; // 100% solid subject
      } else {
        mDst[i * 4 + 3] = 0;
      }
    }
    mCtx.putImageData(mData, 0, 0);
    pushHistory("自动提取透明主体");
    statusText.textContent = tr("subjectDone");
    return true;
  }
  return false;
}

// Binarize Mask Data: PURE SOLID (Alpha=255, RGB=255), No Semi-transparency!
function applyBinarizedMask(probData, threshold) {
  const w = state.source.width;
  const h = state.source.height;
  const mCtx = state.maskCanvas.getContext("2d");
  const imgData = mCtx.createImageData(w, h);
  const dst = imgData.data;

  for (let i = 0; i < probData.length; i++) {
    const val = probData[i];
    const idx = i * 4;
    if (val >= threshold) {
      dst[idx] = 255;     // R
      dst[idx + 1] = 255; // G
      dst[idx + 2] = 255; // B
      dst[idx + 3] = 255; // 100% 绝对纯实心！无任何半透明与漏底
    } else {
      dst[idx] = 0;
      dst[idx + 1] = 0;
      dst[idx + 2] = 0;
      dst[idx + 3] = 0;
    }
  }
  mCtx.putImageData(imgData, 0, 0);
}

// --- Cloud API Matting Engine (BiRefNet / Remove.bg / Custom) ---

// Load Image
function loadImage(src, callback) {
  statusDot.className = "status-dot busy";
  statusText.textContent = tr("reading");
  const img = new Image();
  if (typeof src === "string" && (src.startsWith("http://") || src.startsWith("https://"))) {
    img.crossOrigin = "anonymous";
  }
  img.onload = () => {
    try {
      state.source = fitSource(img);
      state.lineKeepCanvas = null;
      state.maskCanvas = document.createElement("canvas");
      state.maskCanvas.width = state.source.width;
      state.maskCanvas.height = state.source.height;
      resetHistory();

      // Auto-detect transparency: If user drops an image that was already cut out (e.g. from macOS/iOS)
      checkAndExtractTransparency(state.source);
      resetHistory();

      render();
      pushHistory("init");
      statusDot.className = "status-dot ready";
      statusText.textContent = tr("hintCut");
      if (callback) callback();
    } catch (err) {
      console.error("loadImage error:", err);
      statusDot.className = "status-dot error";
      statusText.textContent = tr("imgErr") + err.message;
    }
  };
  img.onerror = (e) => {
    console.error("loadImage onerror:", e);
    statusDot.className = "status-dot";
    statusText.textContent = tr("imgFail");
    toast(() => tr("imgFail"));
  };
  img.src = src;
}

// Load Demo

// Pointer & Drawing
function getCanvasCoords(e) {
  const rect = mainCanvas.getBoundingClientRect();
  const k = state.viewScale || 1;
  const scaleX = mainCanvas.width / k / rect.width;
  const scaleY = mainCanvas.height / k / rect.height;
  const displayX = (e.clientX - rect.left) * scaleX;
  const displayY = (e.clientY - rect.top) * scaleY;

  const widths = getSliceParts(state.source.width);
  const gapPx = 0;

  let accDst = 0;
  let accSrc = 0;
  let srcX = displayX;

  for (let i = 0; i < widths.length; i++) {
    const sw = widths[i];
    if (displayX >= accDst && displayX <= accDst + sw) {
      srcX = accSrc + (displayX - accDst);
      break;
    }
    accDst += sw + gapPx;
    accSrc += sw;
  }

  const focalFracX = srcX / state.source.width;

  return {
    srcX: Math.max(0, Math.min(state.source.width, srcX)),
    srcY: Math.max(0, Math.min(state.source.height, displayY)),
    displayX,
    displayY,
    focalFracX,
  };
}

// ---- 画笔：线段插值 + 合并事件 + 每帧最多渲染一次，快速拖动也不会断 ----
let _rafId = 0;
function scheduleRender() {
  if (_rafId) return;
  _rafId = requestAnimationFrame(() => { _rafId = 0; render(); });
}
let _lastPt = null;
function paintSegment(x0, y0, x1, y1) {
  const mCtx = state.maskCanvas.getContext("2d");
  mCtx.save();
  mCtx.globalCompositeOperation = state.tool === "paint" ? "source-over" : "destination-out";
  mCtx.strokeStyle = mCtx.fillStyle = "#ffffff";
  mCtx.lineWidth = state.brushSize;
  mCtx.lineCap = "round";
  mCtx.lineJoin = "round";
  if (x0 === x1 && y0 === y1) {
    mCtx.beginPath(); mCtx.arc(x1, y1, state.brushSize / 2, 0, Math.PI * 2); mCtx.fill();
  } else {
    mCtx.beginPath(); mCtx.moveTo(x0, y0); mCtx.lineTo(x1, y1); mCtx.stroke();
  }
  mCtx.restore();
}

mainCanvas.addEventListener("pointerdown", (e) => {
  if (!state.source || !isBrushTool()) return;
  const { srcX, srcY } = getCanvasCoords(e);
  state.isPainting = true;
  mainCanvas.setPointerCapture(e.pointerId);
  _lastPt = { x: srcX, y: srcY };
  paintSegment(srcX, srcY, srcX, srcY);
  scheduleRender();
});

mainCanvas.addEventListener("pointermove", (e) => {
  if (!state.source) return;

  if (isBrushTool()) {
    brushIndicator.style.display = "block";
    brushIndicator.style.left = `${e.clientX}px`;
    brushIndicator.style.top = `${e.clientY}px`;
    const rect = mainCanvas.getBoundingClientRect();
    const displaySize = (state.brushSize / state.source.width) * rect.width;
    brushIndicator.style.width = `${displaySize}px`;
    brushIndicator.style.height = `${displaySize}px`;
    brushIndicator.className = state.tool === "paint" ? "paint" : "erase";
  } else {
    brushIndicator.style.display = "none";
  }

  if (state.isPainting && isBrushTool()) {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ce of evs) {
      const { srcX, srcY } = getCanvasCoords(ce);
      if (!_lastPt) _lastPt = { x: srcX, y: srcY };
      paintSegment(_lastPt.x, _lastPt.y, srcX, srcY);
      _lastPt = { x: srcX, y: srcY };
    }
    scheduleRender();
  }
});

function endPointer(e) {
  if (state.isPainting) {
    state.isPainting = false;
    _lastPt = null;
    render();
    pushHistory({ paint: "恢复主体", erase: "擦除主体" }[state.tool] || "笔刷");
  }
}

mainCanvas.addEventListener("pointerup", endPointer);
mainCanvas.addEventListener("pointercancel", endPointer);
mainCanvas.addEventListener("mouseleave", () => {
  brushIndicator.style.display = "none";
});

// Paint onto maskCanvas: 100% Solid White
function ensureLineKeep() {
  const w = state.source.width, h = state.source.height;
  if (!state.lineKeepCanvas || state.lineKeepCanvas.width !== w || state.lineKeepCanvas.height !== h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    state.lineKeepCanvas = c;
  }
  return state.lineKeepCanvas;
}
function isBrushTool() { return state.tool === "paint" || state.tool === "erase"; }

// History listeners & Keybindings
document.getElementById("btnUndo").onclick = undo;
document.getElementById("btnRedo").onclick = redo;

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  }
});

function syncLineCount() {
  state.slotsCount = state.centers.length;
  normalizeRegion();
  const n = state.centers.length + 1;   // 等分列数
  const sc = document.getElementById("slotsCount");
  if (sc) sc.value = String(Math.min(20, n));
  const scv = document.getElementById("slotsCountVal");
  if (scv) scv.textContent = tr("slicesVal", n);
}
// 工具: 「擦线」和「还原线」; 再点一次取消
document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.onclick = () => {
    const wasActive = btn.classList.contains("active");
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
    const tg = document.getElementById("toggleMaskOverlay");
    const setOverlay = (on) => {
      state.showMaskOverlay = on;
      tg.setAttribute("aria-pressed", String(on));
      tg.classList.toggle("active", on);
    };
    if (wasActive) {
      state.tool = "move";
      mainCanvas.className = "cursor-move";
      // 退出工具：恢复进入前的蒙版显示状态，并解除锁定
      setOverlay(!!state._overlayBefore);
      tg.disabled = false;
    } else {
      // 用笔刷时蒙版锁定为开：擦除 = 去掉红色主体，恢复 = 补上红色主体，不会因为看不到蒙版而反过来理解
      if (state.tool === "move") state._overlayBefore = state.showMaskOverlay;
      setOverlay(true);
      tg.disabled = true;
      btn.classList.add("active");
      state.tool = btn.dataset.tool;
      mainCanvas.className = state.tool === "paint" ? "cursor-paint" : "cursor-erase";
    }
    render();
  };
});

// Mask Operations


document.getElementById("brushSize").oninput = (e) => {
  state.brushSize = Number(e.target.value);
  document.getElementById("brushSizeVal").textContent = `${state.brushSize}px`;
};

// Header AI / Select button
// ---- 抠主体 ----
function busy(title, pct) {
  state.isAiProcessing = true;
  loadingModal.hidden = false;
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalDesc").textContent = "";
  document.getElementById("progressBar").style.width = pct + "%";
  statusDot.className = "status-dot busy";
}
function idle() {
  loadingModal.hidden = true;
  state.isAiProcessing = false;
  statusDot.className = "status-dot";
}
function applyProb(prob, label) {
  applyBinarizedMask(prob, 128);
  pushHistory(label);
  state.showMaskOverlay = true;
  document.getElementById("toggleMaskOverlay").setAttribute("aria-pressed", "true");
  render();
  statusText.textContent = tr("subjectDone");
  setTimeout(() => {
    if (state.tool !== "move") return;   // 正在用笔刷修蒙版时保持显示
    state.showMaskOverlay = false;
    document.getElementById("toggleMaskOverlay").setAttribute("aria-pressed", "false");
    render();
  }, 2000);
}

// 浏览器内 U²-Net-P (ONNX Runtime Web)，离线推理，图片不离开本机
let _toastTimer;
function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  _toastBuild = typeof msg === "function" ? msg : null;
  el.textContent = typeof msg === "function" ? msg() : msg;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
let u2Session = null;
// ---- 抠图精修：引导滤波（He & Sun）----
// 小模型的输出很粗，直接二值化边缘会外扩、发糊。用原图的颜色边缘做引导，把软蒙版"贴"回主体真实的轮廓上。
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ro = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[ro + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      tmp[ro + x] = acc / (b - a + 1);
      if (x + r + 1 <= w - 1) acc += src[ro + x + r + 1];
      if (x - r >= 0) acc -= src[ro + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      out[y * w + x] = acc / (b - a + 1);
      if (y + r + 1 <= h - 1) acc += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) acc -= tmp[(y - r) * w + x];
    }
  }
  return out;
}
function guidedFilterRGB(I, p, w, h, r, eps) {
  const n = w * h, [Ir, Ig, Ib] = I;
  const mul = (a, b) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };
  const mIr = boxMean(Ir, w, h, r), mIg = boxMean(Ig, w, h, r), mIb = boxMean(Ib, w, h, r), mP = boxMean(p, w, h, r);
  const cIrp = boxMean(mul(Ir, p), w, h, r), cIgp = boxMean(mul(Ig, p), w, h, r), cIbp = boxMean(mul(Ib, p), w, h, r);
  const vrr = boxMean(mul(Ir, Ir), w, h, r), vrg = boxMean(mul(Ir, Ig), w, h, r), vrb = boxMean(mul(Ir, Ib), w, h, r);
  const vgg = boxMean(mul(Ig, Ig), w, h, r), vgb = boxMean(mul(Ig, Ib), w, h, r), vbb = boxMean(mul(Ib, Ib), w, h, r);
  const ar = new Float32Array(n), ag = new Float32Array(n), ab = new Float32Array(n), bb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rr = vrr[i] - mIr[i] * mIr[i] + eps, rg = vrg[i] - mIr[i] * mIg[i], rb = vrb[i] - mIr[i] * mIb[i];
    const gg = vgg[i] - mIg[i] * mIg[i] + eps, gb = vgb[i] - mIg[i] * mIb[i], b2 = vbb[i] - mIb[i] * mIb[i] + eps;
    const c0 = cIrp[i] - mIr[i] * mP[i], c1 = cIgp[i] - mIg[i] * mP[i], c2 = cIbp[i] - mIb[i] * mP[i];
    // 3x3 对称矩阵求逆
    const i00 = gg * b2 - gb * gb, i01 = gb * rb - rg * b2, i02 = rg * gb - gg * rb;
    const i11 = rr * b2 - rb * rb, i12 = rg * rb - rr * gb, i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02 || 1e-9;
    const a0 = (i00 * c0 + i01 * c1 + i02 * c2) / det;
    const a1 = (i01 * c0 + i11 * c1 + i12 * c2) / det;
    const a2 = (i02 * c0 + i12 * c1 + i22 * c2) / det;
    ar[i] = a0; ag[i] = a1; ab[i] = a2;
    bb[i] = mP[i] - a0 * mIr[i] - a1 * mIg[i] - a2 * mIb[i];
  }
  const mar = boxMean(ar, w, h, r), mag = boxMean(ag, w, h, r), mab = boxMean(ab, w, h, r), mb = boxMean(bb, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, mar[i] * Ir[i] + mag[i] * Ig[i] + mab[i] * Ib[i] + mb[i]));
  return q;
}

async function runBrowserCutout() {
  if (!state.source) { toast(() => tr("needPhoto")); return; }
  if (state.isAiProcessing) return;
  busy(tr("busyCut"), 15);
  try {
    let ortBase = "vendor/ort/";
    if (typeof ort === "undefined") {
      document.getElementById("modalTitle").textContent = tr("prep");
      const load = (src) => new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src; s.onload = res; s.onerror = () => rej(new Error("load"));
        document.head.append(s);
      });
      try { await load(ortBase + "ort.min.js"); }                       // 优先用本地文件（离线可用）
      catch (_) {
        ortBase = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/";
        try { await load(ortBase + "ort.min.js"); } catch (e) { throw new Error(tr("libFail")); }
      }
    }
    ort.env.wasm.wasmPaths = ortBase;
    ort.env.wasm.numThreads = 1;
    if (!u2Session) {
      document.getElementById("modalTitle").textContent = tr("firstModel");
      u2Session = await ort.InferenceSession.create("models/u2netp.onnx", { executionProviders: ["wasm"] });
    }
    document.getElementById("modalTitle").textContent = tr("busyCut");
    document.getElementById("progressBar").style.width = "55%";
    await new Promise((r) => setTimeout(r, 30));

    const S = 320, w = state.source.width, h = state.source.height;
    const sc = document.createElement("canvas");
    sc.width = S; sc.height = S;
    const sctx = sc.getContext("2d");
    sctx.drawImage(state.source, 0, 0, S, S);
    const px = sctx.getImageData(0, 0, S, S).data;
    let mx = 1;
    for (let i = 0; i < px.length; i += 4) mx = Math.max(mx, px[i], px[i + 1], px[i + 2]);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const inp = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) {
      for (let c = 0; c < 3; c++) inp[c * S * S + i] = (px[i * 4 + c] / mx - mean[c]) / std[c];
    }
    // 原图 + 水平翻转各推理一次再平均，减少偶然误判
    const runOnce = async (input) => {
      const out = await u2Session.run({ [u2Session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, S, S]) });
      const o = out[u2Session.outputNames[0]].data;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < o.length; i++) { lo = Math.min(lo, o[i]); hi = Math.max(hi, o[i]); }
      const r = new Float32Array(S * S);
      for (let i = 0; i < r.length; i++) r[i] = (o[i] - lo) / (hi - lo || 1);
      return r;
    };
    const pA = await runOnce(inp);
    document.getElementById("progressBar").style.width = "75%";
    const inpF = new Float32Array(inp.length);
    for (let c = 0; c < 3; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) inpF[c * S * S + y * S + x] = inp[c * S * S + y * S + (S - 1 - x)];
    const pB = await runOnce(inpF);
    const avg = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) avg[y * S + x] = (pA[y * S + x] + pB[y * S + (S - 1 - x)]) / 2;

    // 放大到工作分辨率（最长边 ≤1024），用引导滤波贴合原图边缘
    const sc2 = Math.min(1, 1024 / Math.max(w, h));
    const gw = Math.max(8, Math.round(w * sc2)), gh = Math.max(8, Math.round(h * sc2));
    const small = sctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) { small.data[i * 4] = small.data[i * 4 + 1] = small.data[i * 4 + 2] = 255; small.data[i * 4 + 3] = Math.round(avg[i] * 255); }
    sctx.putImageData(small, 0, 0);
    const wk = document.createElement("canvas");
    wk.width = gw; wk.height = gh;
    const wctx = wk.getContext("2d");
    wctx.imageSmoothingQuality = "high";
    wctx.drawImage(sc, 0, 0, gw, gh);
    const pd = wctx.getImageData(0, 0, gw, gh).data;
    const pSoft = new Float32Array(gw * gh);
    for (let i = 0; i < pSoft.length; i++) pSoft[i] = pd[i * 4 + 3] / 255;
    wctx.clearRect(0, 0, gw, gh);
    wctx.drawImage(state.source, 0, 0, gw, gh);
    const gd = wctx.getImageData(0, 0, gw, gh).data;
    const G = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
    for (let i = 0; i < gw * gh; i++) { G[0][i] = gd[i * 4] / 255; G[1][i] = gd[i * 4 + 1] / 255; G[2][i] = gd[i * 4 + 2] / 255; }
    await new Promise((r) => setTimeout(r, 0));
    const q = guidedFilterRGB(G, pSoft, gw, gh, Math.max(4, Math.round(0.012 * Math.max(gw, gh))), 0.002);

    const qc = document.createElement("canvas");
    qc.width = gw; qc.height = gh;
    const qctx = qc.getContext("2d");
    const qi = qctx.createImageData(gw, gh);
    for (let i = 0; i < q.length; i++) { qi.data[i * 4] = qi.data[i * 4 + 1] = qi.data[i * 4 + 2] = 255; qi.data[i * 4 + 3] = Math.round(q[i] * 255); }
    qctx.putImageData(qi, 0, 0);
    const big = document.createElement("canvas");
    big.width = w; big.height = h;
    const bctx = big.getContext("2d");
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(qc, 0, 0, w, h);
    const bd = bctx.getImageData(0, 0, w, h).data;
    const prob = new Uint8Array(w * h);
    for (let i = 0; i < prob.length; i++) prob[i] = bd[i * 4 + 3];
    applyProb(prob, "AI 抠主体");
  } catch (err) {
    console.error(err);
    toast(() => tr("cutFail") + err.message + (location.protocol === "file:" ? tr("fileHint") : ""), 7000);
  } finally {
    idle();
  }
}

document.getElementById("btnAiHeader").onclick = runBrowserCutout;

// Smooth Edges (Anti-aliasing stair-step remover)

// Mask Import


// X Platform Theme selection (Black / White / Transparent)
document.querySelectorAll("#slotThemeSegGroup .seg-item").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll("#slotThemeSegGroup .seg-item").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    state.slotTheme = btn.dataset.slotTheme;
    syncThemeBadge();

    pushHistory("切换X平台底色: " + state.slotTheme);
    render();
  };
});

// Slots controls
document.getElementById("slotsCount").oninput = (e) => {
  applyImageCount(Number(e.target.value));
  render();
};
document.getElementById("slotsCount").onchange = () => pushHistory("修改切片图片数量");


// Slice Count Slider & Pills (1 ~ 20 slices)
const sliceSlider = document.getElementById("slicesCountSlider");
const sliceVal = document.getElementById("slicesCountVal");

function setSliceCount(count) {
  state.sliceCount = Math.max(1, Math.min(20, count));
  if (sliceSlider) sliceSlider.value = String(state.sliceCount);
  if (sliceVal) sliceVal.textContent = tr("slicesVal", state.sliceCount);

  document.querySelectorAll("#sliceCountPills .preset-pill").forEach((pill) => {
    pill.classList.toggle("active", Number(pill.dataset.count) === state.sliceCount);
  });

  state.focalSpan = Math.max(1, Math.min(state.focalSpan, state.sliceCount));
  state.focalSliceIndex = Math.max(0, Math.min(state.sliceCount - state.focalSpan, state.focalSliceIndex));
  syncSpanUi();
  render();
}

function syncSpanUi() {
  return;
  const sp = document.getElementById("focalSpanSlider");
  if (sp) { sp.max = String(Math.max(1, state.sliceCount)); sp.value = String(state.focalSpan); }
  const v = document.getElementById("focalSpanVal");
  if (v) v.textContent = `${state.focalSpan} 列宽`;
}

function setFocalSpan(span, recenter = true) {
  state.focalSpan = Math.max(1, Math.min(state.sliceCount, span));
  if (recenter) state.focalSliceIndex = Math.floor((state.sliceCount - state.focalSpan) / 2);
  // 立柱宽度与旁边普通切片一致: 槽数 = 占几列 - 1
  state.slotsCount = Math.max(0, Math.min(30, state.focalSpan - 1));
  state.centers = generateSliceCenters(state.slotsCount, "even");
  const sc = document.getElementById("slotsCount");
  if (sc) sc.value = String(state.slotsCount);
  const scv = document.getElementById("slotsCountVal");
  if (scv) scv.textContent = String(state.slotsCount);
  syncSpanUi();
  render();
}

if (sliceSlider) {
  sliceSlider.oninput = (e) => setSliceCount(Number(e.target.value));
  sliceSlider.onchange = () => pushHistory("调整切片数量");
}

document.querySelectorAll("#sliceCountPills .preset-pill").forEach((pill) => {
  pill.onclick = () => {
    pushHistory(`切换切片数至${pill.dataset.count}张`);
    setSliceCount(Number(pill.dataset.count));
  };
});

// 3D 主图宽度
const focalSpanSlider = document.getElementById("focalSpanSlider");
if (focalSpanSlider) {
  focalSpanSlider.oninput = (e) => setFocalSpan(Number(e.target.value));
  focalSpanSlider.onchange = () => pushHistory("调整3D主图宽度");
}
syncSpanUi();

document.getElementById("toggleMaskOverlay").onclick = (e) => {
  state.showMaskOverlay = !state.showMaskOverlay;
  e.currentTarget.setAttribute("aria-pressed", String(state.showMaskOverlay));
  e.currentTarget.classList.toggle("active", state.showMaskOverlay);
  render();
};
// Upload & Drag-Drop
function handleImageFile(file) {
  if (!file) return;
  state.fileName = file.name || "";
  statusDot.className = "status-dot busy";
  statusText.textContent = tr("readLocal");
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    if (state.source) {
      // Check if dropped file is a transparent PNG subject
      const testImg = new Image();
      testImg.onload = () => {
        const tw = testImg.naturalWidth || testImg.width;
        const th = testImg.naturalHeight || testImg.height;
        const testC = document.createElement("canvas");
        testC.width = tw;
        testC.height = th;
        const tCtx = testC.getContext("2d");
        tCtx.drawImage(testImg, 0, 0);
        let transCount = 0;
        try {
          const imgData = tCtx.getImageData(0, 0, tw, th).data;
          for (let i = 3; i < imgData.length; i += 4) {
            if (imgData[i] < 240) transCount++;
          }
        } catch (_) {}
        
        // If image has substantial transparency (> 0.5%), auto-bind as subject mask
        if (transCount > (tw * th) * 0.005) {
          const w = state.source.width;
          const h = state.source.height;
          pushHistory("导入透明主体PNG");

          const scaleC = document.createElement("canvas");
          scaleC.width = w;
          scaleC.height = h;
          const sCtx = scaleC.getContext("2d");
          sCtx.drawImage(testImg, 0, 0, w, h);
          const scaledData = sCtx.getImageData(0, 0, w, h).data;

          const mCtx = state.maskCanvas.getContext("2d");
          const mData = mCtx.createImageData(w, h);
          const dst = mData.data;
          for (let i = 0; i < w * h; i++) {
            if (scaledData[i * 4 + 3] > 80) {
              dst[i * 4] = 255;
              dst[i * 4 + 1] = 255;
              dst[i * 4 + 2] = 255;
              dst[i * 4 + 3] = 255; // 100% solid subject
            } else {
              dst[i * 4 + 3] = 0;
            }
          }
          mCtx.putImageData(mData, 0, 0);
          render();
          statusDot.className = "status-dot ready";
          statusText.textContent = tr("subjectDone");
          return;
        }
        loadImage(dataUrl);
      };
      testImg.onerror = () => loadImage(dataUrl);
      testImg.src = dataUrl;
    } else {
      loadImage(dataUrl);
    }
  };
  reader.onerror = () => {
    statusDot.className = "status-dot error";
    statusText.textContent = tr("readFail");
    toast(() => tr("readFailToast"));
  };
  reader.readAsDataURL(file);
}

document.getElementById("btnUpload").onclick = () => {
  fileInput.value = "";
  fileInput.click();
};
emptyDropzone.onclick = () => {
  fileInput.value = "";
  fileInput.click();
};
fileInput.onchange = () => {
  const f = fileInput.files && fileInput.files[0];
  if (f) handleImageFile(f);
};

["dragover", "dragenter"].forEach((type) => {
  document.body.addEventListener(type, (e) => {
    e.preventDefault();
    document.body.classList.add("drag-over");
  });
});
["dragleave", "dragend"].forEach((type) => {
  document.body.addEventListener(type, () => document.body.classList.remove("drag-over"));
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drag-over");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && (file.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file.name))) {
    handleImageFile(file);
  }
});

async function canvasToBlobBytes(c, type = "image/png", quality = 0.92) {
  const blob = await new Promise((resolve) => c.toBlob(resolve, type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// Download Button Packaging:
// 1. "只有做了伪 3D 效果的页面是一张，其他都要单独生成切片"
// 2. "要么透 要么不透" -> Alpha 严格二值化
// ---- ZIP（仅存储，不压缩：PNG 本来就是压缩过的）----
const _CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = _CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// mode: "zip" 打包成一个 ZIP；"files" 逐张下载。两种方式都不需要选文件夹，所有浏览器都能用。
async function exportImages(mode) {
  if (!state.compositeCanvas) return;
  statusDot.className = "status-dot busy";
  statusText.textContent = tr("packing");
  const w = state.source.width;
  const h = state.source.height;
  const layout = exportLayout(w);
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const save = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  // 只导出图片：按发帖顺序编号 01.png、02.png……（主图和普通切片混排在各自的位置上）
  const files = [];
  for (let i = 0; i < layout.length; i++) {
    const it = layout[i];
    const sw = it.x1 - it.x0;
    const c = document.createElement("canvas");
    c.width = sw;
    c.height = h;
    // 主图：所见即所得（框内的竖槽 + 出画主体）；普通切片：原图原宽，无圆角、无黑边
    c.getContext("2d").drawImage(it.kind === "3d" ? state.compositeCanvas : state.source, it.x0, 0, sw, h, 0, 0, sw, h);
    files.push({ name: `${String(i + 1).padStart(2, "0")}.png`, data: await canvasToBlobBytes(c, "image/png") });
  }

  if (mode === "zip") {
    const zipName = `PopoutX-${stamp}.zip`;
    save(makeZip(files), zipName);
    toast(() => tr("savedZip", files.length, zipName), 4200);
  } else {
    for (const f of files) {
      save(new Blob([f.data], { type: "image/png" }), f.name);
      await new Promise((r) => setTimeout(r, 350));   // 间隔一下，避免浏览器拦截连续下载
    }
    toast(() => tr("savedDownloads", files.length), 4200);
  }
  statusDot.className = "status-dot";
  statusText.textContent = tr("downloaded", layout.length);
}
document.getElementById("btnDownload").onclick = () => exportImages("zip");
document.getElementById("btnDownloadFiles").onclick = () => { flowFlags.exported = true; exportImages("files"); setTimeout(updateFlow, 800); };



// ---- 操作流程：顶部步骤条 + 当前该点的按钮高亮 ----
const flowFlags = { fx: false, exported: false };
function updateFlow() {
  const hasImg = !!state.source;
  const hasSubject = !!state.subjectBox;
  const done = { open: hasImg, cutout: hasImg && hasSubject, slots: hasImg && hasSubject && flowFlags.fx, export: flowFlags.exported };
  const order = ["open", "cutout", "slots", "export"];
  const cur = order.find((k) => !done[k]) || "export";
  document.querySelectorAll("#flow li").forEach((li) => {
    const k = li.dataset.step;
    li.classList.toggle("done", !!done[k]);
    li.classList.toggle("current", k === cur && !done[k]);
  });
  const mark = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle("is-next", on); };
  const pr = document.getElementById("photoRow");
  pr.hidden = !hasImg;
  if (hasImg && state._thumbFor !== state.source) {
    state._thumbFor = state.source;
    const th = document.getElementById("photoThumb"), tc = th.getContext("2d");
    const s = state.source, side = Math.min(s.width, s.height);
    tc.clearRect(0, 0, th.width, th.height);
    tc.drawImage(s, (s.width - side) / 2, (s.height - side) / 2, side, side, 0, 0, th.width, th.height);
    document.getElementById("photoName").textContent = state.fileName || "photo";
    document.getElementById("photoDims").textContent = `${s.width} × ${s.height}`;
  }
  document.getElementById("btnSample2").hidden = hasImg;
  const ul = document.getElementById("uploadLabel");
  const uk = hasImg ? "change" : "pick";
  if (ul.dataset.i18n !== uk) { ul.dataset.i18n = uk; ul.textContent = tr(uk); }
  document.querySelectorAll(".panel-section[data-step]").forEach((p) => {
    const k = p.dataset.step;
    p.classList.toggle("done", !!done[k]);
    p.classList.toggle("current", k === cur && !done[k]);
  });
  document.getElementById("btnReset").disabled = !hasImg;
  document.getElementById("btnDownloadFiles").disabled = document.getElementById("btnDownload").disabled;
  const card = document.getElementById("tweetCard");
  card.classList.toggle("theme-light", state.slotTheme === "white");
  card.classList.toggle("theme-dark", state.slotTheme !== "white");
  mark("btnPickImage", false);
  mark("btnUpload", cur === "open");
  mark("btnAiHeader", cur === "cutout");
  mark("btnDownload", cur === "slots" || cur === "export");
  const hint = tr({ open: "hintOpen", cutout: "hintCut", slots: "hintFx", export: "hintExport" }[cur]);
  const isHint = ["hintOpen", "hintCut", "hintFx", "hintExport", "statusIdle"].some((k) => Object.values(I18N).some((l) => l[k] === statusText.textContent));
  if (!state.isAiProcessing && isHint) statusText.textContent = hint;
}
document.getElementById("slotsCount").addEventListener("input", () => { flowFlags.fx = true; updateFlow(); });
document.querySelectorAll("#slotThemeSegGroup .seg-item").forEach((b) => b.addEventListener("click", () => { flowFlags.fx = true; updateFlow(); }));
document.getElementById("btnDownload").addEventListener("click", () => { flowFlags.exported = true; setTimeout(updateFlow, 800); });

document.getElementById("btnPickImage").onclick = (e) => { e.stopPropagation(); fileInput.value = ""; fileInput.click(); };
async function loadSamplePlain() {
  try {
    const blob = await fetch("assets/sample.jpg").then((r) => { if (!r.ok) throw new Error(); return r.blob(); });
    handleImageFile(new File([blob], "sample.jpg", { type: blob.type || "image/jpeg" }));
  } catch (_) {
    toast(() => tr("sampleFail"));
    throw new Error("sample");
  }
}
document.getElementById("btnSample").onclick = loadSample;
document.getElementById("btnSample2").onclick = loadSample;
// 顶栏的示例按钮：没有照片时直接加载；已有照片时需要再点一次确认，避免误把正在做的作品换掉
(function () {
  const btn = document.getElementById("btnSampleTop"), lab = document.getElementById("sampleTopLabel");
  let timer = null;
  const disarm = () => { clearTimeout(timer); timer = null; btn.classList.remove("armed"); lab.dataset.i18n = "sampleShort"; lab.textContent = tr("sampleShort"); };
  btn.onclick = (e) => {
    if (!state.source) { loadSample(e); return; }
    if (timer) { disarm(); loadSample(e); return; }
    btn.classList.add("armed"); lab.dataset.i18n = "sampleConfirm"; lab.textContent = tr("sampleConfirm");
    timer = setTimeout(disarm, 3200);
  };
})();
updateFlow();

// ---- 使用说明 ----
const helpModal = document.getElementById("helpModal");
function openHelp() { helpModal.hidden = false; document.getElementById("btnHelpClose").focus(); }
function closeHelp() { helpModal.hidden = true; document.getElementById("btnHelp").focus(); }
document.getElementById("btnHelp").onclick = openHelp;
document.getElementById("btnHelpClose").onclick = closeHelp;
helpModal.addEventListener("mousedown", (e) => { if (e.target === helpModal) closeHelp(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !helpModal.hidden) closeHelp(); });

document.getElementById("btnLang").onclick = () => setLang(LANG === "zh" ? "en" : "zh");
applyLang();

// ---- 粘贴图片 (⌘V / Ctrl+V) ----
window.addEventListener("paste", (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
  const items = [...((e.clipboardData && e.clipboardData.items) || [])];
  const it = items.find((x) => x.kind === "file" && x.type.startsWith("image/"));
  const file = it ? it.getAsFile() : null;
  if (!file) {
    if (items.length) toast(() => tr("noImageInClipboard"));
    return;
  }
  e.preventDefault();
  handleImageFile(file.name && file.name !== "image.png" ? file : new File([file], "pasted." + (file.type.split("/")[1] || "png"), { type: file.type }));
  toast(() => tr("pasted"), 1800);
});

// ---- 视觉细节：滑块填充、份数加减、入场动画 ----
function paintRanges() {
  document.querySelectorAll('input[type="range"]').forEach((el) => {
    const p = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty("--p", p + "%");
  });
}
document.querySelectorAll('input[type="range"]').forEach((el) => el.addEventListener("input", paintRanges));
function nudgeSlices(dir) {
  const el = document.getElementById("slotsCount");
  const v = Math.max(+el.min, Math.min(+el.max, +el.value + dir));
  if (v === +el.value) return;
  el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  paintRanges();
}
document.getElementById("slotsMinus").onclick = () => nudgeSlices(-1);
document.getElementById("slotsPlus").onclick = () => nudgeSlices(1);
(function () {
  const card = document.getElementById("tweetCard");
  const orig = window.updateFlow;
  let seen = false;
  window.updateFlow = function () {
    orig && orig.apply(this, arguments);
    paintRanges();
    if (state.source && !seen) {
      seen = true;
      card.classList.remove("is-entering"); void card.offsetWidth; card.classList.add("is-entering");
    }
  };
})();
paintRanges();

// ---- 重置：回到初始状态（保留照片），可撤销 ----
function resetAll() {
  if (!state.source) return;
  const w = state.source.width, h = state.source.height;
  state.maskCanvas.getContext("2d").clearRect(0, 0, w, h);
  state.lineKeepCanvas = null;
  state.slotTheme = "black";
  applyImageCount(10);
  const sc = document.getElementById("slotsCount");
  sc.value = "10";
  document.querySelectorAll("#slotThemeSegGroup .seg-item").forEach((b) => {
    const on = b.dataset.slotTheme === "black";
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  syncThemeBadge();
  // 退出笔刷工具、关掉蒙版显示
  document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
  state.tool = "move"; mainCanvas.className = "cursor-move";
  state.showMaskOverlay = false; state._autoOverlay = false;
  const tg = document.getElementById("toggleMaskOverlay");
  tg.setAttribute("aria-pressed", "false"); tg.classList.remove("active"); tg.disabled = false;
  flowFlags.fx = false; flowFlags.exported = false;
  render();
  pushHistory("reset");
  statusText.textContent = tr("resetDone");
  toast(() => tr("resetDone"), 2600);
}
document.getElementById("btnReset").onclick = resetAll;

// ---- 自动保存 / 恢复上次作品（IndexedDB，只存在本机浏览器里）----
const DB_NAME = "xc-capsule", DB_STORE = "project";   // 沿用旧名，避免用户已保存的作品丢失 / kept for backward compatibility
function dbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function dbGet() { const db = await dbOpen(); return new Promise((res, rej) => { const r = db.transaction(DB_STORE).objectStore(DB_STORE).get("current"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function dbPut(v) { const db = await dbOpen(); return new Promise((res, rej) => { const tx = db.transaction(DB_STORE, "readwrite"); tx.objectStore(DB_STORE).put(v, "current"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
const canvasBlob = (cv, type, q) => new Promise((res) => cv.toBlob(res, type, q));
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveProject, 1200);
}
async function saveProject() {
  if (!state.source || !state.maskCanvas) return;
  try {
    if (state._srcBlobFor !== state.source) { state._srcBlob = await canvasBlob(state.source, "image/jpeg", 0.95); state._srcBlobFor = state.source; }
    const mask = await canvasBlob(state.maskCanvas, "image/png");
    await dbPut({ source: state._srcBlob, mask, theme: state.slotTheme, count: Number(document.getElementById("slotsCount").value), t: Date.now() });
  } catch (_) { /* 无痕模式等情况下不能保存，忽略 */ }
}
async function restoreProject() {
  try {
    const p = await dbGet();
    if (!p) return false;
    const bmp = await createImageBitmap(p.source);
    const src = document.createElement("canvas");
    src.width = bmp.width; src.height = bmp.height;
    src.getContext("2d").drawImage(bmp, 0, 0);
    state.source = src;
    state.lineKeepCanvas = null;
    state.maskCanvas = document.createElement("canvas");
    state.maskCanvas.width = src.width; state.maskCanvas.height = src.height;
    if (p.mask) state.maskCanvas.getContext("2d").drawImage(await createImageBitmap(p.mask), 0, 0);
    state.slotTheme = p.theme === "white" ? "white" : "black";
    document.querySelectorAll("#slotThemeSegGroup .seg-item").forEach((b) => {
      const on = b.dataset.slotTheme === state.slotTheme;
      b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
    });
    const n = Math.max(1, Math.min(20, p.count || 10));
    document.getElementById("slotsCount").value = String(n);
    applyImageCount(n);
    resetHistory();
    render();
    pushHistory("init");
    paintRanges();
    toast(() => tr("resumed"), 2200);
    return true;
  } catch (_) { return false; }
}
document.getElementById("btnResume").onclick = async (e) => { e.stopPropagation(); await restoreProject(); };
(async () => {
  try { if (await dbGet()) document.getElementById("btnResume").hidden = false; } catch (_) {}
})();

// ---- 快捷键 ----
function toolActive() { return state.tool !== "move"; }
function setBrush(v) {
  const el = document.getElementById("brushSize");
  state.brushSize = Math.max(+el.min, Math.min(+el.max, v));
  el.value = String(state.brushSize);
  document.getElementById("brushSizeVal").textContent = `${state.brushSize}px`;
  paintRanges();
}
function setPeek(on) {
  if (state.peek === on) return;
  state.peek = on;
  if (state.source) render();
}
window.addEventListener("keydown", (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
  if (!document.getElementById("helpModal").hidden) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); const b = document.getElementById("btnDownload"); if (!b.disabled) b.click(); return; }
  if (mod || e.altKey) return;
  const k = e.key;
  if (k === " " && toolActive()) { e.preventDefault(); if (!e.repeat) setPeek(true); return; }
  if (tag === "INPUT" && e.target.type !== "range") return;
  if (!state.source) return;
  if (k === "e" || k === "E") { document.getElementById("toolLineErase").click(); }
  else if (k === "r" || k === "R") { document.getElementById("toolLineRestore").click(); }
  else if (k === "[" ) { setBrush(state.brushSize - (e.shiftKey ? 20 : 5)); }
  else if (k === "]" ) { setBrush(state.brushSize + (e.shiftKey ? 20 : 5)); }
  else if (k === "Escape" && toolActive()) { document.querySelector(".tool-btn.active").click(); }
  if (document.activeElement && document.activeElement.classList.contains("tool-btn")) document.activeElement.blur();
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") { if (state.peek) e.preventDefault(); setPeek(false); }
});
window.addEventListener("blur", () => setPeek(false));
// 提示条：用笔刷时显示"按住空格对比"
(function () {
  const chip = document.getElementById("peekHint");
  const sync = () => { chip.hidden = !(state.tool !== "move"); };
  document.querySelectorAll(".tool-btn").forEach((b) => b.addEventListener("click", () => setTimeout(sync, 0)));
  sync();
})();


// ---- GitHub 按钮 ----
(function () {
  const a = document.getElementById("btnGithub");
  if (GITHUB_URL) { a.href = GITHUB_URL; a.target = "_blank"; }
  else { a.addEventListener("click", (e) => { e.preventDefault(); toast(() => tr("githubSoon"), 2200); }); }
})();

// ---- 移除当前照片，回到空状态（已自动保存的作品仍可通过「继续上次作品」找回）----
function removePhoto() {
  if (!state.source) return;
  clearTimeout(_saveTimer);
  state.source = null; state.maskCanvas = null; state.lineKeepCanvas = null;
  state.subjectBox = null; state.subjectCols = null; state.hasRegion = false;
  state.compositeCanvas = null; state.compositeTransparentCanvas = null;
  state._thumbFor = null; state.fileName = "";
  document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
  state.tool = "move"; mainCanvas.className = "cursor-move";
  state.showMaskOverlay = false; state.peek = false;
  const tg = document.getElementById("toggleMaskOverlay");
  tg.setAttribute("aria-pressed", "false"); tg.classList.remove("active"); tg.disabled = false;
  document.getElementById("peekHint").hidden = true;
  mainCanvas.hidden = true; emptyDropzone.hidden = false;
  slicesContainer.replaceChildren();
  document.getElementById("btnDownload").disabled = true;
  flowFlags.fx = false; flowFlags.exported = false;
  resetHistory();
  statusDot.className = "status-dot";
  statusText.textContent = tr("hintOpen");
  updateFlow();
  dbGet().then((p) => { if (p) document.getElementById("btnResume").hidden = false; }).catch(() => {});
  toast(() => tr("removed"), 3200);
}
document.getElementById("btnRemovePhoto").onclick = removePhoto;

// ---- 引导教程：点「示例」载入示例照片，然后一步步引导用户自己去点；用户完成该步，才进入下一步 ----
function loadSample(e) { if (e) e.stopPropagation(); startTour(); }
async function startTour() {
  endTour(true);
  const prev = state.source;
  try { await loadSamplePlain(); } catch (_) { return; }
  const t0 = performance.now();
  while (!(state.source && state.source !== prev && state.maskCanvas)) { if (performance.now() - t0 > 15000) return; await new Promise((r) => setTimeout(r, 80)); }
  // 回到教程的起点：黑色底色、10 份
  document.querySelector('[data-slot-theme="black"]').click();
  const sc = document.getElementById("slotsCount");
  if (sc.value !== "10") { sc.value = "10"; sc.dispatchEvent(new Event("input", { bubbles: true })); sc.dispatchEvent(new Event("change", { bubbles: true })); }
  const steps = [
    { target: () => document.getElementById("btnAiHeader"), done: () => !!state.subjectBox, side: "auto" },
    { target: () => [document.querySelector(".count-row"), document.getElementById("slotsCount")], done: () => Number(sc.value) !== 10, side: "auto" },
    { target: () => document.querySelector('[data-slot-theme="white"]'), done: () => state.slotTheme === "white", side: "auto" },
    { target: () => document.getElementById("btnDownload"), done: null, side: "auto" },
  ];
  _tour = { steps, i: 0, advancing: false, timer: null, onKey: null, onDl: null };
  document.getElementById("tourSkip").onclick = () => endTour(false);
  document.getElementById("tourDoneBtn").onclick = () => finishTour();
  _tour.onKey = (e) => { if (e.key === "Escape") endTour(false); };
  window.addEventListener("keydown", _tour.onKey);
  _tour.onDl = () => { if (_tour && _tour.i === 3) setTimeout(finishTour, 400); };
  document.getElementById("btnDownload").addEventListener("click", _tour.onDl);
  window.addEventListener("resize", tourPlace);
  document.getElementById("canvasScroller").addEventListener("scroll", tourPlace);
  showTourStep();
  _tour.timer = setInterval(tourTick, 250);
}
function tourRefreshText() {
  const info = tr("tour")[_tour.i];
  document.getElementById("tourStep").textContent = tr("tourOf", _tour.i + 1, _tour.steps.length);
  document.getElementById("tourTitle").textContent = info.title;
  document.getElementById("tourText").textContent = info.text;
  tourPlace();   // 文字长度变了，卡片高度和箭头位置要重算
}
function showTourStep() {
  const s = _tour.steps[_tour.i];
  tourRefreshText();
  document.getElementById("tourDoneBtn").hidden = _tour.i !== _tour.steps.length - 1;
  const card = document.getElementById("tourCard");
  card.hidden = false; document.getElementById("tourSpot").hidden = false;
  card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
  tourPlace();
}
function tourPlace() {
  if (!_tour) return;
  const raw = _tour.steps[_tour.i].target();
  const els = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
  if (!els.length) return;
  els[0].scrollIntoView({ block: "nearest", behavior: "instant" });
  const rs = els.map((e) => e.getBoundingClientRect());
  const r = { left: Math.min(...rs.map((x) => x.left)), top: Math.min(...rs.map((x) => x.top)), right: Math.max(...rs.map((x) => x.right)), bottom: Math.max(...rs.map((x) => x.bottom)) };
  r.width = r.right - r.left; r.height = r.bottom - r.top;
  const pad = 6;
  const spot = document.getElementById("tourSpot");
  spot.style.left = r.left - pad + "px"; spot.style.top = r.top - pad + "px";
  spot.style.width = r.width + pad * 2 + "px"; spot.style.height = r.height + pad * 2 + "px";
  // 提示卡只放在右侧面板里，不遮挡预览画布和底部图片条
  const pane = document.querySelector(".inspector-pane").getBoundingClientRect();
  const card = document.getElementById("tourCard");
  const cw = Math.min(300, pane.width - 20);
  card.style.width = cw + "px";
  const ch = card.offsetHeight || 150, gap = 16;
  const x = Math.max(pane.left + 10, Math.min(pane.right - cw - 10, pane.left + (pane.width - cw) / 2));
  const spaceBelow = pane.bottom - r.bottom, spaceAbove = r.top - pane.top;
  let side = spaceBelow >= ch + gap + 8 || spaceBelow >= spaceAbove ? "bottom" : "top";
  let y = side === "bottom" ? r.bottom + gap : r.top - ch - gap;
  y = Math.max(8, Math.min(innerHeight - ch - 8, y));
  card.style.left = x + "px"; card.style.top = y + "px"; card.dataset.side = side;
  const arrow = r.left + r.width / 2 - x - 6;
  card.style.setProperty("--arrow", Math.max(14, Math.min(cw - 26, arrow)) + "px");
}
function tourTick() {
  if (!_tour) return;
  const s = _tour.steps[_tour.i];
  const modalOpen = !document.getElementById("loadingModal").hidden;
  document.getElementById("tourCard").style.visibility = modalOpen ? "hidden" : "";
  document.getElementById("tourSpot").style.visibility = modalOpen ? "hidden" : "";
  tourPlace();
  if (s.done && !_tour.advancing && s.done()) {
    _tour.advancing = true;
    setTimeout(() => { if (!_tour) return; _tour.i++; _tour.advancing = false; showTourStep(); }, 1300);
  }
}
function finishTour() { endTour(false); toast(() => tr("tourFinish"), 3200); }
function endTour(silent) {
  if (!_tour) return;
  clearInterval(_tour.timer);
  window.removeEventListener("keydown", _tour.onKey);
  window.removeEventListener("resize", tourPlace);
  document.getElementById("canvasScroller").removeEventListener("scroll", tourPlace);
  document.getElementById("btnDownload").removeEventListener("click", _tour.onDl);
  _tour = null;
  document.getElementById("tourCard").hidden = true;
  document.getElementById("tourSpot").hidden = true;
}

// ---- 把 PROFILE 填进发帖预览 ----
(function applyProfile() {
  const url = `https://x.com/${PROFILE.handle}`;
  const av = document.querySelector(".post-avatar");
  av.href = url; av.setAttribute("aria-label", "@" + PROFILE.handle);
  av.querySelector("img").src = PROFILE.avatar;
  const nm = document.querySelector(".post-name"); nm.href = url; nm.querySelector("span").textContent = PROFILE.name;
  const hd = document.querySelector(".post-handle"); hd.href = url; hd.textContent = "@" + PROFILE.handle;
  document.querySelector(".post-name .verified").style.display = PROFILE.verified ? "" : "none";
})();
