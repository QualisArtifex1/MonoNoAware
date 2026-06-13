const canvas = document.querySelector("#painting");
const ctx = canvas.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const grainCanvas = document.createElement("canvas");
const grainCtx = grainCanvas.getContext("2d");
const brushStampCanvas = document.createElement("canvas");
const brushStampCtx = brushStampCanvas.getContext("2d");
const washPatternCanvas = document.createElement("canvas");
const washPatternCtx = washPatternCanvas.getContext("2d");
const washMaskCanvas = document.createElement("canvas");
const washMaskCtx = washMaskCanvas.getContext("2d", { willReadFrequently: true });
const hint = document.querySelector(".hint");
const paper = document.querySelector(".paper");
const fudeCursor = document.querySelector(".fude-cursor");

const assetPath = (file) => {
  const baseUrl = import.meta.env?.BASE_URL;
  return baseUrl
    ? `${baseUrl}assets/${file}`
    : new URL(`../public/assets/${file}`, import.meta.url).href;
};
const revealSources = [
  "cherry-tree.png",
  "daoist-pine-sage.png",
  "daoist-waterfall-hermitage.png",
  "daoist-crane-lotus.png",
  "daoist-river-gorge.png",
  "daoist-moon-gate.png",
].map(assetPath);
const revealImages = revealSources.map((source) => {
  const artwork = new Image();
  artwork.src = source;
  return artwork;
});
let revealIndex = 0;
let image = revealImages[revealIndex];
paper.style.setProperty("--fude-image", `url("${assetPath("fude-brush.png")}")`);
paper.style.setProperty("--paper-image", `url("${assetPath("watercolor-paper.jpg")}")`);

const washTexture = new Image();
washTexture.src = assetPath("watercolor-wash-texture.jpg");
const generalWashShape = new Image();
generalWashShape.src = assetPath("general-wash-shape.jpg");
let brushStampReady = false;
let washPatternReady = false;

let width = 0;
let height = 0;
let dpr = 1;
let drawing = false;
let hasPainted = false;
let lastPoint = null;
let lastMoveAt = 0;
let lastBleedAt = 0;
let lastRenderAt = 0;
let brushAngle = -0.55;
let targetBrushAngle = -0.55;
let lastCursorFrameAt = 0;
let cycleHasPaint = false;
let marks = [];
let imageRect = { x: 0, y: 0, width: 0, height: 0 };

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const DRYING_MULTIPLIER = 1.5;
const DRYING_LIFE = 7200 * DRYING_MULTIPLIER;
const BRUSH_TURN_SPEED = 3.2;

function seededNoise(x, y) {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function buildPaperGrain() {
  grainCanvas.width = Math.round(width * dpr);
  grainCanvas.height = Math.round(height * dpr);
  grainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  grainCtx.clearRect(0, 0, width, height);

  const spacing = 3.8;
  for (let y = 1; y < height; y += spacing) {
    for (let x = 1; x < width; x += spacing) {
      const noise = seededNoise(Math.floor(x / spacing), Math.floor(y / spacing));
      if (noise < 0.46) continue;
      const radius = 0.25 + noise * 0.82;
      grainCtx.fillStyle = `rgba(0,0,0,${0.04 + noise * 0.12})`;
      grainCtx.beginPath();
      grainCtx.ellipse(x, y, radius * 1.8, radius * 0.55, noise * Math.PI, 0, Math.PI * 2);
      grainCtx.fill();
    }
  }
}

function buildGeneralWashStamp() {
  if (!generalWashShape.naturalWidth) return;

  const sourceCanvas = document.createElement("canvas");
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const size = 512;
  sourceCanvas.width = size;
  sourceCanvas.height = size;
  sourceCtx.drawImage(generalWashShape, 0, 0, size, size);

  const source = sourceCtx.getImageData(0, 0, size, size);
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;

  for (let index = 0; index < source.data.length; index += 4) {
    const luminance = source.data[index] / 255;
    const alpha = Math.round(Math.pow(Math.max(0, luminance - 0.035) / 0.965, 1.18) * 255);
    source.data[index] = 0;
    source.data[index + 1] = 0;
    source.data[index + 2] = 0;
    source.data[index + 3] = alpha;

    if (alpha > 8) {
      const pixel = index / 4;
      const x = pixel % size;
      const y = Math.floor(pixel / size);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  sourceCtx.putImageData(source, 0, 0);
  const cropWidth = Math.max(1, maxX - minX + 1);
  const cropHeight = Math.max(1, maxY - minY + 1);
  brushStampCanvas.width = cropWidth;
  brushStampCanvas.height = cropHeight;
  brushStampCtx.drawImage(sourceCanvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  brushStampReady = true;
}

function buildWashPattern() {
  if (!washTexture.naturalWidth) return;

  const size = 720;
  washPatternCanvas.width = size;
  washPatternCanvas.height = size;
  washPatternCtx.clearRect(0, 0, size, size);
  washPatternCtx.filter = "grayscale(1) contrast(185%) brightness(122%)";
  drawCoverImage(washPatternCtx, washTexture, size, size);
  washPatternCtx.filter = "none";

  washMaskCanvas.width = size;
  washMaskCanvas.height = size;
  washMaskCtx.clearRect(0, 0, size, size);
  washMaskCtx.drawImage(washPatternCanvas, 0, 0);
  const mask = washMaskCtx.getImageData(0, 0, size, size);
  for (let index = 0; index < mask.data.length; index += 4) {
    const luminance = mask.data[index] / 255;
    const pigment = 0.66 + (1 - luminance) * 0.34;
    mask.data[index] = 0;
    mask.data[index + 1] = 0;
    mask.data[index + 2] = 0;
    mask.data[index + 3] = Math.round(pigment * 255);
  }
  washMaskCtx.putImageData(mask, 0, 0);
  washPatternReady = true;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  width = rect.width;
  height = rect.height;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildPaperGrain();

  const imageRatio = image.naturalWidth / image.naturalHeight || 1.6;
  const viewportRatio = width / height;
  const scale = viewportRatio > imageRatio ? width / image.naturalWidth : height / image.naturalHeight;
  const artWidth = image.naturalWidth * scale;
  const artHeight = image.naturalHeight * scale;
  imageRect = {
    x: (width - artWidth) / 2,
    y: (height - artHeight) / 2,
    width: artWidth,
    height: artHeight,
  };
}

function setRevealImage(index) {
  revealIndex = index % revealImages.length;
  image = revealImages[revealIndex];
  paper.style.setProperty("--reveal-image", `url("${revealSources[revealIndex]}")`);
  resize();
}

function advanceRevealImage() {
  setRevealImage(revealIndex + 1);
  cycleHasPaint = false;
}

function eventPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    pressure: event.pressure || 0.5,
  };
}

function createBristles(count, speed) {
  return Array.from({ length: count }, (_, index) => {
    const edge = Math.abs(index / Math.max(1, count - 1) - 0.5) * 2;
    return {
      offset: index / Math.max(1, count - 1) - 0.5 + (Math.random() - 0.5) * 0.055,
      width: 0.55 + Math.random() * 2.2 * (1 - edge * 0.48),
      alpha: (0.3 + Math.random() * 0.7) * (1 - edge * 0.58),
      edge,
      lag: Math.random() * Math.min(13, 3 + speed * 7),
      jitter: (Math.random() - 0.5) * 4,
      dry: Math.random() < Math.min(0.12, 0.025 + speed * 0.055),
      dash: 1.5 + Math.random() * 3,
      gap: 2 + Math.random() * 4,
      phase: Math.random() * 8,
    };
  });
}

function createFeathers() {
  return Array.from({ length: 3 }, () => ({
    offset: (Math.random() - 0.5) * 0.82,
    width: 0.54 + Math.random() * 0.58,
    alpha: 0.04 + Math.random() * 0.075,
    bend: (Math.random() - 0.5) * 0.56,
  }));
}

function createBackruns(brushWidth) {
  if (Math.random() > 0.32) return [];
  return Array.from({ length: Math.random() > 0.78 ? 2 : 1 }, () => ({
    along: 0.15 + Math.random() * 0.7,
    offset: (Math.random() - 0.5) * brushWidth * 0.52,
    radius: brushWidth * (0.18 + Math.random() * 0.25),
    strength: 0.045 + Math.random() * 0.055,
    wobble: Math.random() * Math.PI,
  }));
}

function addMark(from, to, pressure, speed, isTouch = false) {
  const base = Math.min(width, height) * 0.094;
  const brushWidth = base * (0.7 + pressure * 0.5) * Math.max(0.72, 1.08 - speed * 0.42);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const angle = distance > 0.1 ? Math.atan2(dy, dx) : -Math.PI / 2;
  const now = performance.now();
  const life = reducedMotion.matches ? 18000 : DRYING_LIFE;
  cycleHasPaint = true;

  marks.push({
    from,
    to,
    angle,
    width: brushWidth,
    born: now,
    life,
    wash: 0.22 + Math.random() * 0.14,
    stampOpacity: 0.13 + Math.random() * 0.12,
    stampRotation: (Math.random() - 0.5) * 0.34,
    stampScaleX: 1.18 + Math.random() * 0.38,
    stampScaleY: 0.78 + Math.random() * 0.28,
    stampOffset: (Math.random() - 0.5) * brushWidth * 0.24,
    isTouch,
    feathers: createFeathers(),
    backruns: createBackruns(brushWidth),
    bristles: createBristles(Math.min(18, Math.round(brushWidth / 4.8)), speed),
  });
}

function drawGeneralWashStamp(mark, alpha) {
  if (!brushStampReady) return;

  const normalX = -Math.sin(mark.angle);
  const normalY = Math.cos(mark.angle);
  const centerX = (mark.from.x + mark.to.x) / 2 + normalX * mark.stampOffset;
  const centerY = (mark.from.y + mark.to.y) / 2 + normalY * mark.stampOffset;
  const stampWidth = mark.width * mark.stampScaleX;
  const stampHeight = mark.width * mark.stampScaleY;

  maskCtx.save();
  maskCtx.translate(centerX, centerY);
  maskCtx.rotate(mark.angle + mark.stampRotation);
  maskCtx.globalAlpha = alpha * mark.stampOpacity;
  maskCtx.drawImage(brushStampCanvas, -stampWidth / 2, -stampHeight / 2, stampWidth, stampHeight);
  maskCtx.restore();
}

function paintBetween(from, to, elapsed) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const spacing = Math.max(9, Math.min(width, height) * 0.013);
  const steps = Math.max(1, Math.ceil(distance / spacing));
  const speed = distance / Math.max(elapsed, 1);
  let previous = from;

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const point = {
      x: from.x + dx * t,
      y: from.y + dy * t,
    };
    const pressure = from.pressure + (to.pressure - from.pressure) * t;
    addMark(previous, point, pressure, speed);
    previous = point;
  }
}

function begin(event) {
  drawing = true;
  hasPainted = true;
  paper.classList.add("is-painting");
  hint.classList.add("is-hidden");
  canvas.setPointerCapture(event.pointerId);
  lastPoint = eventPoint(event);
  fudeCursor.style.setProperty("--x", `${lastPoint.x}px`);
  fudeCursor.style.setProperty("--y", `${lastPoint.y}px`);
  fudeCursor.classList.toggle("is-visible", event.pointerType !== "touch");
  lastMoveAt = performance.now();
  lastBleedAt = lastMoveAt;
  addMark(
    { x: lastPoint.x, y: lastPoint.y + 1 },
    { x: lastPoint.x, y: lastPoint.y - 1 },
    lastPoint.pressure,
    0,
    true,
  );
}

function move(event) {
  const point = eventPoint(event);
  fudeCursor.style.setProperty("--x", `${point.x}px`);
  fudeCursor.style.setProperty("--y", `${point.y}px`);
  fudeCursor.classList.toggle("is-visible", event.pointerType !== "touch");

  if (!drawing || !lastPoint) {
    return;
  }
  const now = performance.now();
  const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
  if (distance < 0.7) return;
  if (distance > 3.5) {
    // The handle leads with the stroke, dragging the bristle tip exactly 180deg behind it.
    targetBrushAngle = Math.atan2(point.y - lastPoint.y, point.x - lastPoint.x) + Math.PI;
  }
  paintBetween(lastPoint, point, now - lastMoveAt);
  lastPoint = point;
  lastMoveAt = now;
  lastBleedAt = now;
}

function end(event) {
  drawing = false;
  lastPoint = null;
  lastBleedAt = 0;
  paper.classList.remove("is-painting");
  fudeCursor.classList.remove("is-pressed");
  if (event.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

function addBleed(point, now) {
  const held = Math.min(1, (now - lastMoveAt) / 2400);
  const radius = Math.min(width, height) * (0.034 + held * 0.068);
  const life = reducedMotion.matches ? 18000 : DRYING_LIFE;
  cycleHasPaint = true;
  marks.push({
    from: { x: point.x, y: point.y },
    to: { x: point.x, y: point.y },
    angle: -Math.PI / 2,
    width: radius * (1.28 + Math.random() * 0.34),
    born: now,
    life,
    wash: 0.24 + held * 0.3,
    isTouch: true,
    isBleed: true,
    bloom: 0.48 + held * 0.34,
    wobble: Math.random() * Math.PI * 2,
    bristles: [],
  });
}

function markOpacity(mark, now) {
  const age = (now - mark.born) / mark.life;
  if (age >= 1) return { age, alpha: 0 };
  const fade = age < 0.62 ? 1 : 1 - (age - 0.62) / 0.38;
  return { age, alpha: Math.max(0, fade) };
}

function drawWash(mark, alpha) {
  const normalX = -Math.sin(mark.angle);
  const normalY = Math.cos(mark.angle);

  maskCtx.save();
  maskCtx.lineCap = "round";
  maskCtx.lineJoin = "round";
  for (let wash = 0; wash < 3; wash += 1) {
    maskCtx.strokeStyle = `rgba(0,0,0,${alpha * mark.wash * (0.42 - wash * 0.075)})`;
    maskCtx.lineWidth = mark.width * (0.74 + wash * 0.25);
    maskCtx.beginPath();
    maskCtx.moveTo(mark.from.x, mark.from.y);
    maskCtx.lineTo(mark.to.x, mark.to.y);
    maskCtx.stroke();
  }

  for (const feather of mark.feathers) {
    const offset = feather.offset * mark.width;
    const fromX = mark.from.x + normalX * offset;
    const fromY = mark.from.y + normalY * offset;
    const toX = mark.to.x + normalX * offset;
    const toY = mark.to.y + normalY * offset;
    const midX = (fromX + toX) / 2 + normalX * feather.bend * mark.width;
    const midY = (fromY + toY) / 2 + normalY * feather.bend * mark.width;
    maskCtx.strokeStyle = `rgba(0,0,0,${alpha * feather.alpha})`;
    maskCtx.lineWidth = mark.width * feather.width;
    maskCtx.beginPath();
    maskCtx.moveTo(fromX, fromY);
    maskCtx.quadraticCurveTo(midX, midY, toX, toY);
    maskCtx.stroke();
  }

  maskCtx.restore();
}

function drawBristles(mark, alpha) {
  const normalX = -Math.sin(mark.angle);
  const normalY = Math.cos(mark.angle);
  const tangentX = Math.cos(mark.angle);
  const tangentY = Math.sin(mark.angle);

  maskCtx.save();
  maskCtx.lineCap = "round";

  for (const bristle of mark.bristles) {
    const offset = bristle.offset * mark.width;
    const startX = mark.from.x + normalX * offset - tangentX * bristle.lag;
    const startY = mark.from.y + normalY * offset - tangentY * bristle.lag;
    const endX = mark.to.x + normalX * (offset + bristle.jitter);
    const endY = mark.to.y + normalY * (offset + bristle.jitter);
    const midX = (startX + endX) / 2 + normalX * bristle.jitter * 0.7;
    const midY = (startY + endY) / 2 + normalY * bristle.jitter * 0.7;

    maskCtx.strokeStyle = `rgba(0,0,0,${alpha * bristle.alpha})`;
    maskCtx.lineWidth = bristle.width;
    maskCtx.setLineDash(bristle.dry ? [bristle.dash, bristle.gap] : []);
    maskCtx.lineDashOffset = bristle.phase;
    maskCtx.beginPath();
    maskCtx.moveTo(startX, startY);
    maskCtx.quadraticCurveTo(midX, midY, endX, endY);
    maskCtx.stroke();
  }

  maskCtx.setLineDash([]);
  maskCtx.restore();
}

function drawBackruns(mark, age, alpha) {
  if (age < 0.22 || age > 0.78) return;
  const normalX = -Math.sin(mark.angle);
  const normalY = Math.cos(mark.angle);
  const development = Math.sin(((age - 0.22) / 0.56) * Math.PI);

  maskCtx.save();
  for (const backrun of mark.backruns) {
    const x = mark.from.x + (mark.to.x - mark.from.x) * backrun.along + normalX * backrun.offset;
    const y = mark.from.y + (mark.to.y - mark.from.y) * backrun.along + normalY * backrun.offset;
    const radius = backrun.radius * (0.72 + development * 0.42);
    maskCtx.strokeStyle = `rgba(0,0,0,${alpha * backrun.strength * development})`;
    maskCtx.lineWidth = Math.max(0.8, radius * 0.12);
    maskCtx.beginPath();
    maskCtx.ellipse(x, y, radius, radius * (0.72 + Math.sin(backrun.wobble) * 0.12), backrun.wobble, 0, Math.PI * 2);
    maskCtx.stroke();
  }
  maskCtx.restore();
}

function drawTouch(mark, alpha) {
  const age = (performance.now() - mark.born) / mark.life;
  const bloom = mark.isBleed ? mark.bloom + Math.min(age / 0.2, 1) * 0.2 : 0.46;
  const radius = mark.width * bloom;
  const gradient = maskCtx.createRadialGradient(mark.to.x, mark.to.y, radius * 0.05, mark.to.x, mark.to.y, radius);
  gradient.addColorStop(0, `rgba(0,0,0,${alpha * (mark.isBleed ? mark.wash : 1)})`);
  gradient.addColorStop(0.52, `rgba(0,0,0,${alpha * (mark.isBleed ? mark.wash * 0.7 : 0.55)})`);
  gradient.addColorStop(0.78, `rgba(0,0,0,${alpha * (mark.isBleed ? mark.wash * 0.28 : 0.16)})`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  maskCtx.fillStyle = gradient;
  maskCtx.beginPath();
  maskCtx.ellipse(
    mark.to.x,
    mark.to.y,
    radius * (0.86 + Math.sin(mark.wobble || 0) * 0.08),
    radius * (1 + Math.cos(mark.wobble || 0) * 0.08),
    mark.wobble || 0,
    0,
    Math.PI * 2,
  );
  maskCtx.fill();
}

function drawMask(now) {
  maskCtx.clearRect(0, 0, width, height);
  maskCtx.globalCompositeOperation = "source-over";

  for (const mark of marks) {
    const { age, alpha } = markOpacity(mark, now);
    if (alpha <= 0) continue;
    if (mark.isTouch) drawTouch(mark, alpha);
    if (mark.isBleed) continue;
    drawGeneralWashStamp(mark, alpha);
    drawWash(mark, alpha);
    drawBristles(mark, alpha);
    drawBackruns(mark, age, alpha);
  }

  maskCtx.save();
  maskCtx.globalCompositeOperation = "destination-out";
  maskCtx.globalAlpha = 0.62;
  maskCtx.drawImage(grainCanvas, 0, 0, width, height);
  maskCtx.restore();

  if (washPatternReady) {
    const washMask = maskCtx.createPattern(washMaskCanvas, "repeat");
    if (washMask) {
      maskCtx.save();
      maskCtx.globalCompositeOperation = "destination-in";
      maskCtx.globalAlpha = 1;
      maskCtx.fillStyle = washMask;
      maskCtx.fillRect(0, 0, width, height);
      maskCtx.restore();
    }
  }
}

function drawCoverImage(context, artwork, targetWidth, targetHeight) {
  if (!artwork.naturalWidth) return;
  const scale = Math.max(targetWidth / artwork.naturalWidth, targetHeight / artwork.naturalHeight);
  const drawWidth = artwork.naturalWidth * scale;
  const drawHeight = artwork.naturalHeight * scale;
  context.drawImage(artwork, (targetWidth - drawWidth) / 2, (targetHeight - drawHeight) / 2, drawWidth, drawHeight);
}

function drawWashTexture(context, targetWidth, targetHeight) {
  if (!washPatternReady) return;

  const pattern = context.createPattern(washPatternCanvas, "repeat");
  if (!pattern) return;

  context.save();
  context.globalCompositeOperation = "multiply";
  context.globalAlpha = 0.38;
  context.fillStyle = pattern;
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.restore();
}

function animateBrush(now) {
  const elapsed = lastCursorFrameAt ? Math.min((now - lastCursorFrameAt) / 1000, 0.05) : 0;
  lastCursorFrameAt = now;

  const delta = Math.atan2(
    Math.sin(targetBrushAngle - brushAngle),
    Math.cos(targetBrushAngle - brushAngle),
  );
  const turn = Math.sign(delta) * Math.min(Math.abs(delta), BRUSH_TURN_SPEED * elapsed);
  brushAngle += turn;
  fudeCursor.style.setProperty("--angle", `${brushAngle}rad`);
}

function draw(now) {
  requestAnimationFrame(draw);
  animateBrush(now);

  if (now - lastRenderAt < 32) return;
  lastRenderAt = now;

  const heldFor = now - lastMoveAt;
  const bleedInterval = Math.max(110, 260 - heldFor * 0.045);
  if (drawing && lastPoint && now - lastBleedAt > bleedInterval) {
    addBleed(lastPoint, now);
    lastBleedAt = now;
  }

  const markCountBeforeDrying = marks.length;
  marks = marks.filter((mark) => now - mark.born < mark.life);
  if (cycleHasPaint && markCountBeforeDrying > 0 && marks.length === 0) {
    advanceRevealImage();
  }
  drawMask(now);

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height);
  drawWashTexture(ctx, width, height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.globalAlpha = 1;
  ctx.drawImage(maskCanvas, 0, 0, width, height);
  ctx.restore();

  ctx.save();
  ctx.lineCap = "round";
  for (const mark of marks) {
    if (mark.isBleed) continue;
    const { age } = markOpacity(mark, now);
    if (age > 0.18) continue;
    const freshness = 1 - age / 0.18;
    ctx.strokeStyle = `rgba(171, 107, 112, ${0.026 * freshness})`;
    ctx.lineWidth = mark.width * (1.02 + age * 0.5);
    ctx.beginPath();
    ctx.moveTo(mark.from.x, mark.from.y);
    ctx.lineTo(mark.to.x, mark.to.y);
    ctx.stroke();
  }
  ctx.restore();

}

canvas.addEventListener("pointerdown", begin);
canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") fudeCursor.classList.add("is-pressed");
});
canvas.addEventListener("pointermove", move);
canvas.addEventListener("pointerup", end);
canvas.addEventListener("pointercancel", end);
canvas.addEventListener("pointerleave", (event) => {
  fudeCursor.classList.remove("is-visible");
  if (event.buttons === 0) end(event);
});

window.addEventListener("resize", resize);
revealImages.forEach((artwork) => artwork.addEventListener("load", resize));
generalWashShape.addEventListener("load", buildGeneralWashStamp);
washTexture.addEventListener("load", buildWashPattern);
setRevealImage(0);
resize();
buildGeneralWashStamp();
buildWashPattern();
requestAnimationFrame(draw);

window.setTimeout(() => {
  if (!hasPainted) hint.classList.add("is-present");
}, 900);
