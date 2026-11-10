// Executed only in the synthetic Electron fixture, never shipped to the application.
(() => {
  const scroll = document.querySelector('.excel-table').parentElement;
  const table = scroll.querySelector('table');
  const region = scroll.parentElement;
  const properties = ['transition', 'animation', 'boxShadow', 'filter', 'backdropFilter', 'contain', 'contentVisibility', 'willChange', 'transform'];
  const summary = {};
  for (const [label, items] of Object.entries({
    ancestors: [document.documentElement, document.body, document.getElementById('root'), region, scroll, table],
    header: [...table.querySelectorAll('thead, thead tr, thead td, thead input')],
    rows: [...table.querySelectorAll('tbody tr.fast-row')],
    cells: [...table.querySelectorAll('tbody tr.fast-row td')],
    inputs: [...table.querySelectorAll('tbody tr.fast-row input')]
  })) {
    const counts = {};
    for (const el of items) {
      const css = getComputedStyle(el);
      for (const prop of properties) {
        const value = prop === 'transition' ? `${css.transitionProperty} ${css.transitionDuration}` :
          prop === 'animation' ? `${css.animationName} ${css.animationDuration}` : css[prop];
        if ((prop === 'transition' && css.transitionDuration === '0s') ||
          (prop === 'animation' && css.animationName === 'none')) continue;
        if (value && !['none', 'normal', 'visible', ''].includes(value) && !(prop === 'willChange' && value === 'auto')) {
          const key = `${prop}:${value}`;
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    }
    summary[label] = { count: items.length, effects: counts };
  }
  const selectors = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    const visit = (list) => {
      for (const rule of list) {
        if (rule.cssRules) visit(rule.cssRules);
        if (!rule.selectorText || !/excel-table|excel-grid-container|fast-row|soft-input/.test(rule.selectorText)) continue;
        const declarations = properties.filter(p => rule.style?.getPropertyValue(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase())));
        if (declarations.length) selectors.push({ selector: rule.selectorText, properties: declarations });
      }
    };
    visit(rules);
  }
  const style = document.createElement('style');
  style.textContent = '.excel-grid-container, .excel-grid-container * { transition: none !important; animation: none !important; box-shadow: none !important; filter: none !important; backdrop-filter: none !important; }';
  const gaps = [];
  const tasks = [];
  let wheelEvents = 0, scrollEvents = 0;
  scroll.addEventListener('wheel', () => { wheelEvents++; }, { passive: true });
  scroll.addEventListener('scroll', () => { scrollEvents++; }, { passive: true });
  let observer;
  try {
    observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration); });
    observer.observe({ type: 'longtask', buffered: false });
  } catch { /* Long Task API may be unavailable in this Electron build. */ }
  let active = false, previous = 0, rafId = 0;
  const tick = t => { if (!active) return; if (previous) gaps.push(t - previous); previous = t; rafId = requestAnimationFrame(tick); };
  const coverage = () => ({ rows: table.querySelectorAll('tbody tr.fast-row').length,
    cells: table.querySelectorAll('tbody tr.fast-row td').length,
    inputs: table.querySelectorAll('tbody tr.fast-row input').length,
    visibleRows: [...table.querySelectorAll('tbody tr.fast-row')].filter(r => {
      const b = r.getBoundingClientRect(), s = scroll.getBoundingClientRect();
      return b.bottom > s.top && b.top < s.bottom;
    }).length });
  const api = {
    inspect: () => ({ summary, selectors, baselineCoverage: coverage(),
      viewport: { width: scroll.clientWidth, height: scroll.clientHeight, scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight },
      focusVisible: document.visibilityState === 'visible' && document.hasFocus(),
      gpuCanvas: (() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })() }),
    begin: (disabled) => {
      if (disabled) region.appendChild(style); else style.remove();
      scroll.scrollTop = 600; scroll.scrollLeft = 300;
      // Fixed pointer over the table: no mouse moves between variants or wheel samples.
      gaps.length = 0; tasks.length = 0; wheelEvents = 0; scrollEvents = 0; previous = 0; active = true;
      rafId = requestAnimationFrame(tick);
      return { x: Math.round(scroll.getBoundingClientRect().left + 420), y: Math.round(scroll.getBoundingClientRect().top + 210) };
    },
    end: () => {
      active = false; cancelAnimationFrame(rafId);
      const sorted = [...gaps].sort((a, b) => a - b);
      return { frames: gaps.length, over33: gaps.filter(n => n > 33).length, over50: gaps.filter(n => n > 50).length,
        p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null,
        longTasks: tasks.length, longTaskMs: Math.round(tasks.reduce((a, b) => a + b, 0)),
        scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft, wheelEvents, scrollEvents, coverage: coverage(),
        focusVisible: document.visibilityState === 'visible' && document.hasFocus() };
    },
    cleanup: () => { active = false; cancelAnimationFrame(rafId); observer?.disconnect(); style.remove(); }
  };
  window.hisobCssProbe = api;
  return api.inspect();
})()
