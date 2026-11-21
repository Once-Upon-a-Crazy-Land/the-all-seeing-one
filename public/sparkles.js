const layers = document.querySelectorAll('.sparkle-layer');
const credits = document.querySelector('.opening-credits');
const creditsTrail = credits?.querySelector('.cursor-sparkles');
const pageTrail = document.querySelector('.home-page > .cursor-sparkles');
const previewEffects = document.querySelector('.preview-effects');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const creditsGlow = { x: 50, y: 58, spreadX: 39, spreadY: 39 };
const titleGlow = { x: 25, y: 54, spreadX: 24, spreadY: 39 };
const walletGlow = { x: 80, y: 69, spreadX: 19, spreadY: 28 };
const interactiveControls = 'a[href], button, input, select, textarea, label, summary, [contenteditable], [role="button"], [role="link"]';

const randomBetween = (min, max) => min + Math.random() * (max - min);
const around = (center, spread) => center + (Math.random() + Math.random() - 1) * spread;

function makeSparkle(index, { x, y, duration, drift, rise }) {
  const sparkle = document.createElement('span');
  sparkle.className = 'sparkle';
  sparkle.classList.toggle('sparkle-warm', index % 3 === 0);
  sparkle.classList.toggle('sparkle-glint', index % 5 === 0);
  sparkle.style.setProperty('--sparkle-x', x);
  sparkle.style.setProperty('--sparkle-y', y);
  sparkle.style.setProperty('--sparkle-size', randomBetween(1.5, 3.6) + 'px');
  sparkle.style.setProperty('--sparkle-brightness', randomBetween(.52, .91));
  sparkle.style.setProperty('--sparkle-drift', drift + 'px');
  sparkle.style.setProperty('--sparkle-rise', rise + 'px');
  sparkle.style.setProperty('--sparkle-duration', duration + 's');
  return sparkle;
}

function addSparkles(layer, inCredits) {
  const sparkles = document.createDocumentFragment();
  const count = inCredits ? 36 : 48;
  for (let index = 0; index < count; index++) {
    const glow = inCredits ? creditsGlow : (index % 3 === 2 ? walletGlow : titleGlow);
    const duration = randomBetween(5.5, 10);
    const sparkle = makeSparkle(index, {
      x: around(glow.x, glow.spreadX) + '%',
      y: around(glow.y, glow.spreadY) + '%',
      duration,
      drift: randomBetween(-40, 40),
      rise: randomBetween(-112, -44)
    });
    sparkle.style.setProperty('--sparkle-delay', -Math.random() * duration + 's');
    sparkles.append(sparkle);
  }
  layer.append(sparkles);
}

function clearTrail(trail) {
  trail?.classList.remove('has-cursor');
  trail?.replaceChildren();
}

function updateSparkles() {
  if (reducedMotion.matches) {
    window.clearTimeout(glowTimeout);
    clearTrail(pageTrail);
    previewEffects?.replaceChildren();
  }
  if (reducedMotion.matches || !credits?.open) clearTrail(creditsTrail);

  for (const layer of layers) {
    const inCredits = credits?.contains(layer);
    if (reducedMotion.matches || (inCredits && !credits.open)) {
      layer.replaceChildren();
    } else if (!layer.childElementCount) {
      addSparkles(layer, inCredits);
    }
  }
}

let lastTrailAt = -Infinity;
let trailIndex = 0;
let glowTimeout;

function activeTrail() {
  return credits?.open ? creditsTrail : pageTrail;
}

function emitSparkle(trail, options) {
  const sparkle = makeSparkle(trailIndex++, options);
  if (trail.childElementCount >= 40) trail.firstElementChild.remove();
  sparkle.addEventListener('animationend', () => sparkle.remove(), { once: true });
  trail.append(sparkle);
}

function followCursor(event) {
  if (reducedMotion.matches || event.pointerType !== 'mouse') return;
  const trail = activeTrail();
  if (!trail) return;
  trail.style.setProperty('--cursor-x', event.clientX + 'px');
  trail.style.setProperty('--cursor-y', event.clientY + 'px');
  trail.classList.add('has-cursor');
  window.clearTimeout(glowTimeout);
  glowTimeout = window.setTimeout(hideCursorGlow, 220);

  if (event.timeStamp - lastTrailAt < 22) return;
  lastTrailAt = event.timeStamp;

  emitSparkle(trail, {
    x: (event.clientX + randomBetween(-3, 3)) + 'px',
    y: (event.clientY + randomBetween(-3, 3)) + 'px',
    duration: randomBetween(.48, .72),
    drift: randomBetween(-15, 15),
    rise: randomBetween(-28, -12)
  });
}

function hideCursorGlow() {
  window.clearTimeout(glowTimeout);
  pageTrail?.classList.remove('has-cursor');
  creditsTrail?.classList.remove('has-cursor');
}

function burstSparkles(event) {
  if (reducedMotion.matches || event.defaultPrevented || event.button !== 0 || !event.detail ||
      event.target.closest?.(interactiveControls) || window.getSelection()?.isCollapsed === false) return;
  const trail = activeTrail();
  if (!trail) return;

  const count = 9;
  const rotation = randomBetween(0, Math.PI * 2);
  for (let index = 0; index < count; index++) {
    const angle = rotation + index * Math.PI * 2 / count + randomBetween(-.12, .12);
    const distance = randomBetween(18, 38);
    emitSparkle(trail, {
      x: event.clientX + 'px',
      y: event.clientY + 'px',
      duration: randomBetween(.36, .56),
      drift: Math.cos(angle) * distance,
      rise: Math.sin(angle) * distance - 4
    });
  }
}

export function playPreviewSparkles(layer) {
  if (reducedMotion.matches) return;

  const glow = document.createElement('div');
  glow.className = 'preview-glow';
  glow.addEventListener('animationend', () => {
    if (glow.parentElement === layer) layer.replaceChildren();
  }, { once: true });

  const particles = document.createDocumentFragment();
  const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [outX, outY] of directions) {
    const count = outY ? 5 : 3;
    for (let index = 0; index < count; index++) {
      const position = 10 + 80 * index / (count - 1) + randomBetween(-3, 3);
      const distance = randomBetween(20, 42);
      const sway = randomBetween(-10, 10);
      particles.append(makeSparkle(particles.childElementCount, {
        x: (outX ? (outX + 1) * 50 : position) + '%',
        y: (outY ? (outY + 1) * 50 : position) + '%',
        duration: randomBetween(.49, .82),
        drift: outX * distance + outY * sway,
        rise: outY * distance + outX * sway
      }));
    }
  }
  layer.replaceChildren(glow, particles);
}

updateSparkles();
document.addEventListener('pointermove', followCursor, { passive: true });
document.addEventListener('click', burstSparkles);
document.documentElement.addEventListener('pointerleave', hideCursorGlow);
window.addEventListener('blur', hideCursorGlow);
reducedMotion.addEventListener('change', updateSparkles);
credits?.addEventListener('close', updateSparkles);
