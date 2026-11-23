// Draw-or-type signatures, exported as a trimmed PNG with a transparent background.
const INK = '#17292a';
const MAX_WIDTH = 900;

function trimToPng(source) {
  const ctx = source.getContext('2d');
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  const w = maxX - minX + 1 + pad * 2, hgt = maxY - minY + 1 + pad * 2;
  const scale = Math.min(1, MAX_WIDTH / w);
  const out = document.createElement('canvas');
  out.width = Math.round(w * scale);
  out.height = Math.round(hgt * scale);
  out.getContext('2d').drawImage(source, minX - pad, minY - pad, w, hgt, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function createSignaturePad(canvas, { onChange } = {}) {
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;

  function resize() {
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }

  function drawStroke(points) {
    if (!points.length) return;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (points.length === 1) {
      ctx.beginPath(); ctx.arc(points[0].x, points[0].y, 1.4, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2, my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    const last = points.at(-1);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(s);
  }

  const point = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!current) return;
    e.preventDefault();
    current.push(point(e));
    redraw();
  });
  const end = () => { if (current) { current = null; onChange?.(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  window.addEventListener('resize', resize);
  requestAnimationFrame(resize);

  return {
    clear() { strokes = []; redraw(); onChange?.(); },
    isEmpty() { return !strokes.some(s => s.length); },
    toPng() { return trimToPng(canvas); },
  };
}

export async function typedSignaturePng(name, font = '500 64px Caveat') {
  try { await document.fonts.load(font); } catch {}
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `${font}, 'Segoe Script', 'Snell Roundhand', cursive`;
  const w = Math.ceil(ctx.measureText(name).width) + 40;
  c.width = Math.max(40, w);
  c.height = 110;
  ctx.font = `${font}, 'Segoe Script', 'Snell Roundhand', cursive`;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 20, 58);
  return trimToPng(c);
}
