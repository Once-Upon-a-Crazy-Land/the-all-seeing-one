const credits = document.querySelector('.opening-credits');
const scene = credits?.querySelector('.opening-scene');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (credits?.showModal && scene && !reducedMotion.matches && !window.location.hash) {
  credits.showModal();

  // Keep the homepage reachable if the stylesheet or animation is unavailable.
  const fallback = window.setTimeout(() => credits.close(), 6000);
  let flyingTitle;

  function dismissIfReduced(event) {
    if (event.matches) credits.close();
  }

  function carryTitle(event) {
    if (event.target !== scene) return;
    const source = scene.querySelector('.opening-slide-finale .home-wordmark');
    const heading = document.getElementById('home-heading');
    if (!source || !heading) return;

    const start = source.getBoundingClientRect();
    const end = heading.getBoundingClientRect();
    const sourceSize = Number.parseFloat(getComputedStyle(source).fontSize);
    const headingSize = Number.parseFloat(getComputedStyle(heading).fontSize);
    // Let the fade finish on its own if the heading is off screen or either title has wrapped.
    if (end.top < 0 || end.bottom > window.innerHeight ||
        start.height > sourceSize * 1.5 || end.height > headingSize * 1.5) return;

    const frame = credits.getBoundingClientRect();
    flyingTitle = source.cloneNode(true);
    flyingTitle.classList.add('opening-title-flight');
    flyingTitle.setAttribute('aria-hidden', 'true');
    flyingTitle.style.left = (start.left - frame.left) + 'px';
    flyingTitle.style.top = (start.top - frame.top) + 'px';
    flyingTitle.style.fontSize = sourceSize + 'px';
    flyingTitle.style.setProperty('--title-x', (end.left - start.left) + 'px');
    flyingTitle.style.setProperty('--title-y', (end.top - start.top) + 'px');
    flyingTitle.style.setProperty('--title-scale', headingSize / sourceSize);
    credits.append(flyingTitle);
    credits.classList.add('is-handing-off');
  }

  function finishIntro(event) {
    if (event.target === scene) credits.close();
  }

  reducedMotion.addEventListener('change', dismissIfReduced);
  scene.addEventListener('animationstart', carryTitle);
  scene.addEventListener('animationend', finishIntro);
  credits.addEventListener('close', () => {
    window.clearTimeout(fallback);
    reducedMotion.removeEventListener('change', dismissIfReduced);
    scene.removeEventListener('animationstart', carryTitle);
    scene.removeEventListener('animationend', finishIntro);
    credits.classList.remove('is-handing-off');
    flyingTitle?.remove();
  }, { once: true });
}
