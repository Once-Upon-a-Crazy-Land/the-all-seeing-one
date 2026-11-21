import { exampleCategories } from './home-example-data.js';
import { playPreviewSparkles } from './sparkles.js';

const showcase = document.querySelector('.home-showcase');

if (showcase) {
  const tablist = showcase.querySelector('.preview-tabs');
  const panel = showcase.querySelector('#bot-example');
  const template = panel.querySelector('.preview-example');
  const announcement = showcase.querySelector('.preview-announcement');
  const effects = showcase.querySelector('.preview-effects');
  const credits = document.querySelector('.opening-credits');
  const rotationDelay = 5000;
  let selectedCategory = -1;
  let selectedExample = 0;
  let activePreview;
  let rotationTimer;
  let previewVisible = false;

  const previews = exampleCategories.map(category => category.examples.map(example => {
    const preview = template.cloneNode(true);
    preview.setAttribute('aria-hidden', 'true');
    preview.querySelector('[data-preview-channel-mark]').hidden = Boolean(example.direct);
    preview.querySelector('[data-preview-channel]').textContent = example.direct ? 'Direct message' : (example.channel ?? category.channel);
    preview.querySelector('[data-preview-caption]').textContent = example.caption ?? example.label;
    if (!example.wallet) preview.querySelector('.preview-panel').replaceChildren(renderMessage(example));
    return preview;
  }));

  const tabs = exampleCategories.map((category, index) => {
    const tab = document.createElement('button');
    tab.id = 'preview-category-' + category.id;
    tab.className = 'preview-tab';
    tab.type = 'button';
    tab.textContent = category.name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('click', () => {
      if (selectedCategory === index) {
        advanceExample();
      } else {
        selectCategory(index);
      }
    });
    return tab;
  });

  function renderMessage(example) {
    if (example.image) {
      const { file, width, height } = example.image;
      const attachment = new Image(width, height);
      attachment.className = 'preview-attachment';
      attachment.alt = example.summary;
      attachment.src = '/images/showcase/' + file;
      const summary = document.createElement('p');
      summary.className = 'preview-attachment-summary';
      summary.setAttribute('aria-hidden', 'true');
      summary.textContent = example.summary;
      const fragment = document.createDocumentFragment();
      fragment.append(attachment, summary);
      return fragment;
    }

    const message = document.createElement('div');
    message.className = example.plain ? 'preview-plain' : 'preview-embed';
    if (example.title) {
      const title = document.createElement('strong');
      title.textContent = example.title;
      message.append(title);
      if (example.divider) message.append(document.createElement('hr'));
    }
    const body = document.createElement('p');
    body.textContent = example.body;
    message.append(body);
    return message;
  }

  function scheduleRotation() {
    window.clearTimeout(rotationTimer);
    if (!previewVisible || document.hidden || credits?.open || panel.matches(':focus-within')) return;
    rotationTimer = window.setTimeout(() => advanceExample({ announce: false }), rotationDelay);
  }

  function advanceExample(options) {
    const count = previews[selectedCategory].length;
    selectExample((selectedExample + 1) % count, options);
  }

  function selectExample(index, { animate = true, announce = animate } = {}) {
    activePreview?.setAttribute('aria-hidden', 'true');
    selectedExample = index;
    activePreview = previews[selectedCategory][index];
    activePreview.removeAttribute('aria-hidden');
    activePreview.prepend(effects);
    announcement.textContent = announce ? activePreview.querySelector('[data-preview-caption]').textContent : '';
    if (animate) playPreviewSparkles(effects);
    scheduleRotation();
  }

  function selectCategory(index, options) {
    if (selectedCategory === index) return;
    selectedCategory = index;
    for (const [position, tab] of tabs.entries()) {
      const selected = position === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', tabs[index].id);
    selectExample(0, options);
  }

  document.addEventListener('visibilitychange', scheduleRotation);
  credits?.addEventListener('close', scheduleRotation);
  panel.addEventListener('focus', () => window.clearTimeout(rotationTimer));
  panel.addEventListener('blur', scheduleRotation);
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    previewVisible = entry.isIntersecting;
    scheduleRotation();
  });

  tablist.addEventListener('keydown', event => {
    const current = tabs.indexOf(event.target);
    if (current === -1) return;

    let next;
    switch (event.key) {
      case 'ArrowRight': next = (current + 1) % tabs.length; break;
      case 'ArrowLeft': next = (current - 1 + tabs.length) % tabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = tabs.length - 1; break;
      default: return;
    }

    event.preventDefault();
    selectCategory(next);
    tabs[next].focus();
  });

  tablist.append(...tabs);
  panel.replaceChildren(...previews.flat());
  panel.setAttribute('role', 'tabpanel');
  panel.tabIndex = 0;
  selectCategory(0, { animate: false });
  tablist.hidden = false;
  visibilityObserver.observe(panel);
}
