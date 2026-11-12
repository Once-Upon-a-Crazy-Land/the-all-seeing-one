const gearLayer = document.querySelector('.falling-gears');
const reducedGearMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const gearSizes = [
  { name: 'small', sprite: 'small', count: 64 },
  { name: 'medium', sprite: 'med', count: 32 },
  { name: 'large', sprite: 'big', count: 10 }
];

let gearDensityKey;

function renderFallingGears() {
  // Match the reference at 2000 × 1000, with fewer gears on smaller screens.
  const density = Math.min(1.25, gearLayer.clientWidth * gearLayer.clientHeight / 2_000_000);
  const counts = gearSizes.map(size => reducedGearMotion.matches ? 0 : Math.round(size.count * density));
  const key = counts.join(',');
  if (key === gearDensityKey) return;
  gearDensityKey = key;

  const gears = document.createDocumentFragment();
  gearSizes.forEach(({ name, sprite }, sizeIndex) => {
    const count = counts[sizeIndex];
    for (let index = 0; index < count; index++) {
      const gear = document.createElement('img');
      gear.className = 'falling-gear gear-' + name;
      gear.src = '/images/falling-gear-' + sprite + (index % 2 + 1) + '.png';
      gear.alt = '';
      gear.style.setProperty('--gear-left', (Math.random() * 100) + '%');
      // Distribute the gears through their cycles so they are already falling on load.
      const phase = (index + Math.random()) / count;
      gear.style.setProperty('--gear-delay', 'calc(var(--gear-period) * ' + -phase + ')');
      gears.append(gear);
    }
  });
  gearLayer.replaceChildren(gears);
}

renderFallingGears();
window.addEventListener('resize', renderFallingGears);
reducedGearMotion.addEventListener('change', renderFallingGears);
