(() => {
  'use strict';

  const API = '/api/admin/webapp';
  const telegram = window.Telegram && window.Telegram.WebApp;
  const state = {
    sessionToken: '',
    expiresAt: 0,
    user: null,
    access: null,
    currentView: 'overview',
    selectedCompanyId: '',
    companyFilter: 'all',
    companySearchQuery: '',
    currentCpTab: 'overview',
    previousView: 'overview',
    companies: [],
    activations: [],
    workers: [],
    companyAdmins: [],
    workerOffset: 0,
    workerFilters: {},
    bindingOffset: 0,
    activationSubmitting: false,
    workerSubmitting: false,
    balanceSubmitting: false,
    balanceWorkerSearch: '',
    currentCpWorkers: [],
    cpWorkerSearchQuery: '',
    workerSubTab: 'list',
    workerFilter: 'all',
    workerSearchQuery: '',
    payrollMonthOffset: 0,
    payrollSearchQuery: '',
    actSubTab: 'requests',
    deviceFilter: 'all',
    deviceSearchQuery: '',
    selectedWorkerPayroll: null,
    viewLoaders: new Map()
  };

  const byId = (id) => document.getElementById(id);

  function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function setOnlineStatus(isOnline, labelText = null) {
    const topDot = byId('topOnlineIndicator');
    if (topDot) {
      topDot.classList.toggle('is-offline', !isOnline);
      topDot.title = isOnline ? 'Tizim onlayn' : 'Aloqa uzilgan (Oflayn)';
    }
    const pill = byId('connectionPill');
    if (pill) {
      pill.classList.toggle('is-offline', !isOnline);
    }
    const label = byId('connectionLabel');
    if (label) {
      label.textContent = labelText || (isOnline ? 'Ulangan' : 'Oflayn');
    }
  }

  function setChipDot(id, status) {
    const el = byId(id);
    if (!el) return;
    el.className = `sys-chip-dot ${status === 'green' ? 'sys-dot-green' : status === 'amber' ? 'sys-dot-amber' : 'sys-dot-red'}`;
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }

  function svgIcon(paths, size = 18, strokeWidth = 2, viewBox = '0 0 24 24') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(strokeWidth));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of (Array.isArray(paths) ? paths : [paths])) {
      if (typeof d === 'string') {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      } else if (d && d.tag) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', d.tag);
        for (const [k, v] of Object.entries(d.attrs || {})) {
          el.setAttribute(k, String(v));
        }
        svg.appendChild(el);
      }
    }
    return svg;
  }

  function cell(row, value, className, label) {
    const td = node('td', className, value);
    if (label) td.dataset.label = label;
    row.appendChild(td);
    return td;
  }

  function money(value) {
    const amount = Number(value || 0);
    return `${Number.isFinite(amount) ? Math.round(amount).toLocaleString('uz-UZ') : '0'} so‘m`;
  }

  function number(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Math.round(amount).toLocaleString('uz-UZ') : '0';
  }

  function timestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const parts = new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${fields.day}.${fields.month}.${fields.year} ${fields.hour}:${fields.minute}`;
  }

  function formatRelativeTime(value) {
    if (!value) return 'Hali sinxronlanmagan';
    const date = new Date(value);
    const time = date.getTime();
    if (Number.isNaN(time)) return 'Hali sinxronlanmagan';
    const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (diffSec < 60) return 'Hozirgina';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} daqiqa oldin`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} soat oldin`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} kun oldin`;
  }

  function statusLabel(value) {
    const labels = {
      PENDING: 'Kutilmoqda', APPROVED: 'Faol', REJECTED: 'Rad etilgan', REVOKED: 'Bekor qilingan',
      ACTIVE: 'Faol', INACTIVE: 'Nofaol'
    };
    return labels[String(value || '').toUpperCase()] || String(value || 'Noma’lum');
  }

  function statusBadge(value) {
    const key = String(value || '').toLowerCase();
    const badge = node('span', `badge badge-${key}`, statusLabel(value));
    return badge;
  }

  function setNotice(message, kind = 'info') {
    const notice = byId('globalNotice');
    if (!notice) return;
    notice.textContent = message;
    notice.className = `global-notice notice-${kind}`;
    notice.hidden = !message;
    if (message && kind === 'error') {
      try { telegram?.HapticFeedback?.notificationOccurred?.('error'); } catch { }
    }
  }

  let toastTimer = 0;
  function toast(message) {
    const element = byId('toast');
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { element.hidden = true; }, 3800);
    try { telegram?.HapticFeedback?.notificationOccurred?.('success'); } catch { }
  }

  function showAuthError(message, retry = true) {
    byId('authGate').hidden = false;
    byId('adminApp').hidden = true;
    byId('authMessage').textContent = message;
    byId('authError').hidden = false;
    byId('authError').textContent = 'Kirish rad etildi. Himoyalangan ma’lumot ko‘rsatilmaydi.';
    byId('retryAuth').hidden = !retry;
  }

  function clearSession(message) {
    state.sessionToken = '';
    state.expiresAt = 0;
    state.user = null;
    showAuthError(message || 'Telegram ichidan qayta ochib, administrator sifatida kiring.', true);
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (state.sessionToken && options.auth !== false) headers.set('Authorization', `Bearer ${state.sessionToken}`);
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error'
      });
    } catch {
      setOnlineStatus(false, 'Aloqa yo‘q');
      const error = new Error('API_UNAVAILABLE');
      error.code = 'API_UNAVAILABLE';
      throw error;
    }
    setOnlineStatus(true, 'Ulangan');
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (response.status === 401 || response.status === 403) {
      const code = result?.error?.code || 'ADMIN_SESSION_REJECTED';
      if (options.auth !== false && ['ADMIN_SESSION_REQUIRED', 'ADMIN_SESSION_INVALID', 'ADMIN_SESSION_EXPIRED', 'ADMIN_SESSION_NOT_AUTHORIZED', 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED'].includes(code)) {
        clearSession('Admin sessiyasi tugagan yoki ruxsat bekor qilingan.');
      }
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    if (!response.ok || result?.success !== true) {
      const error = new Error(result?.error?.code || 'ADMIN_API_REQUEST_FAILED');
      error.code = result?.error?.code || 'ADMIN_API_REQUEST_FAILED';
      throw error;
    }
    return result;
  }

  function withQuery(route, values) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values || {})) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    return suffix ? `${route}?${suffix}` : route;
  }

  function updatePendingNavBadge(count) {
    const badge = byId('navPendingBadge');
    if (badge) badge.hidden = !count || count <= 0;
    const banner = byId('urgentActivationBanner');
    if (banner) {
      banner.hidden = !count || count <= 0;
      if (count > 0) {
        setText('urgentBannerTitle', `${number(count)} ta yangi aktivatsiya so‘rovi`);
        setText('urgentBannerSubtitle', 'Qurilmalarni tasdiqlash yoki ko‘rib chiqish uchun bosing');
      } else {
        setText('urgentBannerTitle', '—');
        setText('urgentBannerSubtitle', '—');
      }
    }
  }

  function tableMessage(tbodyId, emptyId, rows, emptyMessage) {
    const tbody = byId(tbodyId);
    const empty = byId(emptyId);
    tbody.replaceChildren();
    empty.hidden = rows.length > 0;
    if (emptyMessage) empty.textContent = emptyMessage;
    const applyLabels = () => {
      const table = tbody.closest('table');
      if (!table) return;
      const labels = [...table.querySelectorAll('thead th')].map((header) => header.textContent.trim());
      for (const row of tbody.rows) {
        [...row.cells].forEach((item, index) => {
          if (!item.dataset.label && labels[index]) {
            item.dataset.label = labels[index];
          }
        });
      }
    };
    if (!tbody._mobileLabelsObserver) {
      tbody._mobileLabelsObserver = new MutationObserver(() => {
        applyLabels();
      });
      tbody._mobileLabelsObserver.observe(tbody, { childList: true });
    }
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
      window.requestAnimationFrame(applyLabels);
    }
    return tbody;
  }

  async function loadOverview() {
    const isGlobal = state.access?.isGlobalAdmin !== false;
    const dirContainer = byId('directorOverview');
    const globalContainer = byId('globalOverview');
    const targetCompanyId = !isGlobal ? (state.access?.companyIds?.[0] || '') : state.selectedCompanyId;

    if (targetCompanyId && dirContainer && globalContainer) {
      dirContainer.hidden = false;
      globalContainer.hidden = true;
      const companyId = targetCompanyId;
      const company = (state.companies || []).find((c) => c.companyId === companyId) || { companyId, companyName: companyId ? `Korxona (${companyId})` : 'Korxona' };
      const coTitle = company.companyName || (company.companyId ? `Korxona (${company.companyId})` : 'Korxona');
      setText('dirCompanyName', coTitle);
      setText('dirCompanyId', `ID: ${company.companyId || '—'}`);
      setText('mobileBrandName', coTitle);
      setText('mobileBrandInitial', coTitle.charAt(0).toUpperCase());

      const returnBanner = byId('coGlobalReturnBanner');
      if (returnBanner) {
        returnBanner.hidden = !isGlobal;
        setText('coReturnCompanyName', coTitle);
      }

      try {
        const queryParams = { companyId };
        const [overviewRes, payrollRes, partiesRes, ticketsRes, modelsRes, workersRes] = await Promise.all([
          request(withQuery(`${API}/overview`, queryParams)).catch(() => ({ overview: {} })),
          request(withQuery(`${API}/payroll`, queryParams)).catch(() => ({ payroll: {} })),
          request(withQuery(`${API}/parties`, queryParams)).catch(() => ({ parties: [] })),
          request(withQuery(`${API}/tickets`, { ...queryParams, limit: 6 })).catch(() => ({ tickets: [] })),
          request(withQuery(`${API}/models`, queryParams)).catch(() => ({ models: [] })),
          request(withQuery(`${API}/workers`, { ...queryParams, limit: 100 })).catch(() => ({ workers: [] }))
        ]);

        const summary = overviewRes.overview || {};
        const payroll = payrollRes.payroll || {};
        const workersList = payroll.workers || [];
        const totalPieces = workersList.reduce((sum, w) => sum + Number(w.pieces || 0), 0);
        const totalGross = workersList.reduce((sum, w) => sum + Number(w.gross || 0), 0);
        const totalAvans = workersList.reduce((sum, w) => sum + Number(w.avans || 0), 0);
        const totalJarima = workersList.reduce((sum, w) => sum + Number(w.jarima || 0), 0);
        const totalStaj = workersList.reduce((sum, w) => sum + Number(w.staj || 0), 0);
        const totalNet = workersList.reduce((sum, w) => sum + Number(w.net || 0), 0);
        const remaining = Math.max(0, totalGross - totalNet);

        // Date and timestamp
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timeStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        setText('coOverviewTimestamp', timeStr);

        const pendingCount = Number(summary.pendingActivations || 0);
        setText('coPendingHeroCount', number(pendingCount));
        setText('coPendingHeroText', pendingCount > 0 ? `${pendingCount} ta so‘rov` : 'Navbat bo‘sh');
        const heroBadge = byId('coPendingHeroBadge');
        if (heroBadge) {
          const checkSpan = heroBadge.querySelector('.co-badge-check');
          if (checkSpan) checkSpan.textContent = pendingCount > 0 ? '⚡' : '✓';
        }

        const allWorkers = workersRes.workers || [];
        const workersCount = Number(summary.workers || workersList.length || allWorkers.length || 0);
        setText('coStatWorkers', number(workersCount));
        const modelsList = modelsRes.models || [];
        setText('coStatModels', number(modelsList.length || summary.models || 0));
        const allParties = partiesRes.parties || [];
        const activeParties = allParties.filter((p) => p.status !== 'CLOSED');
        setText('coStatParties', number(activeParties.length || summary.parties || 0));
        setText('coStatDevices', number(summary.devices || 0));

        // 1. Ishchilar sof foydasi & Oylik fondi
        const displayedNet = totalNet > 0 ? totalNet : totalGross;
        setText('coStatPayroll', displayedNet > 0 ? number(displayedNet) : '0');
        setText('coGrossPayroll', money(totalGross));
        setText('coAvansPayroll', totalAvans > 0 ? `-${money(totalAvans)}` : '0 so‘m');
        setText('coDeductionsPayroll', (totalJarima > 0 || totalStaj > 0) ? `-${money(totalJarima + totalStaj)}` : '0 so‘m');
        setText('coPiecesCount', `${number(totalPieces)} dona`);

        const payPct = totalGross > 0 ? Math.round((totalNet / totalGross) * 100) : 0;
        setText('coPayrollPct', `${payPct}%`);
        const payFill = byId('coPayrollProgressFill');
        if (payFill) payFill.style.width = `${payPct}%`;
        setText('coPayrollPaid', totalNet > 0 ? `To‘langan ${(totalNet / 1000000).toFixed(1)} mln` : 'To‘langan 0');
        setText('coPayrollRemaining', remaining > 0 ? `Qoldi ${(remaining / 1000000).toFixed(1)} mln` : 'Qoldi 0');

        // 2. Partiyalar umumiy statistikasi
        setText('dirPartySummaryLabel', `${activeParties.length} ta faol · jami ${allParties.length} ta`);

        // 3. Modellar va ratsenkalar yig'indisi
        let companyTotalRatesSum = 0;
        for (const m of modelsList) {
          const mRate = (m.operations || []).reduce((s, op) => s + Number(op.rate || 0), 0);
          m.totalRate = mRate;
          companyTotalRatesSum += mRate;
        }
        setText('dirModelTotalRatesLabel', `Jami ratsenka: ${number(companyTotalRatesSum)} so‘m`);
        const modelList = byId('dirModelList');
        if (modelList) {
          modelList.replaceChildren();
          const previewModels = modelsList.slice(0, 5);
          byId('dirModelEmpty').hidden = previewModels.length > 0;
          for (const m of previewModels) {
            const card = node('article', 'model-touch-card');
            const top = node('div', 'party-touch-card-top');
            const title = node('strong', 'party-touch-title', m.name || m.modelId);
            const rateBadge = node('span', 'badge badge-active', `${number(m.totalRate || 0)} so‘m`);
            top.appendChild(title);
            top.appendChild(rateBadge);
            card.appendChild(top);

            const ops = m.operations || [];
            const meta = node('div', 'worker-touch-stats');
            meta.appendChild(node('span', '', `Ratsenka summasi: ${number(m.totalRate || 0)} so‘m`));
            meta.appendChild(node('span', 'mono muted', `Amallar: ${ops.length} ta`));
            card.appendChild(meta);
            modelList.appendChild(card);
          }
        }

        // 4. Workerlar Telegram holati (Bound / Unbound)
        const boundWorkersList = allWorkers.filter((w) => Boolean(w.binding?.telegramId));
        const unboundWorkersList = allWorkers.filter((w) => !w.binding?.telegramId && w.status === 'ACTIVE');
        const boundCount = boundWorkersList.length || Number(summary.workerBindings || 0);
        const totalWorkersForRatio = allWorkers.length || workersCount;

        setText('coBoundWorkersCount', `${boundCount} ta`);
        setText('coUnboundWorkersCount', `${unboundWorkersList.length} ta`);
        setText('coTelegramRatio', `${number(boundCount)} / ${number(totalWorkersForRatio)}`);
        const tgPct = totalWorkersForRatio > 0 ? Math.round((boundCount / totalWorkersForRatio) * 100) : 0;
        const tgFill = byId('coTelegramProgressFill');
        if (tgFill) tgFill.style.width = `${tgPct}%`;

        const unboundBox = byId('coUnboundAttentionBox');
        const unboundListEl = byId('coUnboundWorkersList');
        if (unboundBox && unboundListEl) {
          unboundListEl.replaceChildren();
          if (unboundWorkersList.length > 0) {
            unboundBox.hidden = false;
            for (const uw of unboundWorkersList.slice(0, 8)) {
              const chip = node('span', 'co-unbound-chip', `${uw.name} (#${uw.workerId})`);
              unboundListEl.appendChild(chip);
            }
            if (unboundWorkersList.length > 8) {
              unboundListEl.appendChild(node('span', 'co-unbound-chip co-unbound-more', `+${unboundWorkersList.length - 8} ta yana`));
            }
          } else {
            unboundBox.hidden = true;
          }
        }

        // Legacy / fallback fields
        setText('dirPeriodBadge', payroll.period?.name || 'Joriy ochiq davr');
        setText('dirStatPieces', totalPieces > 0 ? number(totalPieces) : number(summary.workerBindings || 0));
        setText('dirStatWorkers', number(workersCount));
        setText('dirStatParties', number(summary.parties || activeParties.length));
        setText('dirStatPayroll', money(displayedNet));

        const partyList = byId('dirPartyList');
        if (partyList) {
          partyList.replaceChildren();
          const parties = (partiesRes.parties || []).filter((p) => p.status !== 'CLOSED').slice(0, 5);
          byId('dirPartyEmpty').hidden = parties.length > 0;
          for (const party of parties) {
            const card = node('article', 'party-touch-card');
            const top = node('div', 'party-touch-card-top');
            const title = node('strong', 'party-touch-title', `№ ${party.partyNumber} · ${party.modelName || party.modelId || 'Model'}`);
            top.appendChild(title);
            top.appendChild(statusBadge(party.status));
            card.appendChild(top);

            const total = Number(party.pattaCount || 0);
            const sewn = Number(party.ishSoni || 0);
            const pct = total > 0 ? Math.min(100, Math.round((sewn / total) * 100)) : 0;

            const statsLine = node('div', 'worker-touch-stats');
            statsLine.appendChild(node('span', '', `${number(sewn)} / ${number(total)} dona`));
            statsLine.appendChild(node('span', 'mono', `${pct}% bajarildi`));
            card.appendChild(statsLine);

            const bar = node('div', 'batch-progress-bar');
            const fill = node('div', 'batch-progress-fill');
            fill.style.width = `${pct}%`;
            bar.appendChild(fill);
            card.appendChild(bar);

            partyList.appendChild(card);
          }
        }

        const ticketList = byId('dirTicketList');
        if (ticketList) {
          ticketList.replaceChildren();
          const tickets = ticketsRes.tickets || [];
          byId('dirTicketEmpty').hidden = tickets.length > 0;
          for (const t of tickets) {
            const card = node('article', 'ticket-touch-card');
            const top = node('div', 'worker-touch-card-top');
            top.appendChild(node('strong', '', t.workerName ? `${t.workerName} (#${t.workerId})` : `#${t.workerId || '—'}`));
            top.appendChild(statusBadge(t.status));
            card.appendChild(top);

            const sub = node('div', 'count-label', `${t.modelName || t.modelId || '—'} · ${t.operation || 'Amal'} · ${number(t.quantity)} dona`);
            card.appendChild(sub);
            card.appendChild(node('time', 'mono muted', timestamp(t.effectiveAt)));
            ticketList.appendChild(card);
          }
        }
        updatePendingNavBadge(pendingCount);
        setText('lastUpdated', `Yangilandi ${timestamp(new Date().toISOString())}`);
        return;
      } catch {
        // Fallback gracefully
        return;
      }
    } else if (dirContainer && globalContainer) {
      dirContainer.hidden = true;
      globalContainer.hidden = false;
    }

    if (dirContainer) dirContainer.hidden = true;
    if (globalContainer) globalContainer.hidden = false;
    setText('mobileBrandName', 'Novo System');
    setText('mobileBrandInitial', 'N');

    const [overviewResult, activationResult] = await Promise.all([
      request(`${API}/overview`),
      request(withQuery(`${API}/activations`, { status: 'PENDING', limit: 8 }))
    ]);
    const summary = overviewResult.overview || {};
    setText('metricCompanies', number(summary.companies));
    setText('metricWorkers', number(summary.workers));
    setText('metricModels', number(summary.models));
    setText('metricParties', number(summary.parties));
    setText('metricDevices', number(summary.devices));
    setText('metricPending', number(summary.pendingActivations));
    setText('metricBindings', number(summary.workerBindings));
    setText('recentSyncAt', summary.recentSyncAt ? timestamp(summary.recentSyncAt) : 'Hali mavjud emas');

    // System Admin Executive Mobile Dashboard Fields
    const pendingCount = Number(summary.pendingActivations || 0);
    setText('sysPendingHeroCount', number(pendingCount));
    setText('sysPendingHeroText', pendingCount > 0 ? `${pendingCount} ta so‘rov` : 'Navbat bo‘sh');
    setText('sysMetricCompanies', number(summary.companies || 0));
    setText('sysMetricWorkers', number(summary.workers || 0));
    setText('sysMetricDevices', number(summary.devices || 0));

    // Dynamic Executive Dashboard Chips
    const isBotActive = Boolean(telegram && (telegram.initData || telegram.version));
    setChipDot('sysChipPgDot', 'green');
    setChipDot('sysChipBotDot', isBotActive ? 'green' : 'amber');
    setChipDot('sysChipApiDot', 'green');
    const syncAgeMinutes = summary.recentSyncAt
      ? Math.max(0, Math.round((Date.now() - new Date(summary.recentSyncAt).getTime()) / 60000))
      : 999;
    setChipDot('sysChipSyncDot', summary.recentSyncAt && syncAgeMinutes < 120 ? 'green' : 'amber');

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setText('sysOverviewTimestamp', timeStr);

    renderSysAttentionFeed(summary, pendingCount);

    if (state.companies && state.companies.length) {
      renderSysActiveCompanies();
    } else {
      try {
        const coRes = await request(`${API}/companies`);
        state.companies = coRes.companies || [];
        renderSysActiveCompanies();
      } catch { }
    }

    updatePendingNavBadge(Number(summary.pendingActivations || 0));
    const rows = activationResult.activations || [];
    const tbody = tableMessage('overviewActivationRows', 'overviewActivationEmpty', rows);
    for (const item of rows) {
      const row = node('tr');
      cell(row, String(item.requestId || '').slice(0, 8), 'mono');
      cell(row, item.machineId, 'mono');
      cell(row, item.clientContext?.appVersion || '—');
      cell(row, timestamp(item.requestedAt));
      const actionCell = node('td');
      const actBtn = node('button', 'small-action button-accent-action', 'Tasdiqlash →');
      actBtn.type = 'button';
      actBtn.dataset.selectActivation = item.requestId;
      actionCell.appendChild(actBtn);
      row.appendChild(actionCell);
      tbody.appendChild(row);
    }
    setText('lastUpdated', `Yangilandi ${timestamp(new Date().toISOString())}`);
  }

  function renderSysAttentionFeed(summary, pendingCount) {
    const feed = byId('sysAttentionFeed');
    const badge = byId('sysAttentionCountBadge');
    if (!feed) return;
    feed.replaceChildren();

    const items = [];
    if (pendingCount > 0) {
      items.push({
        iconType: 'red',
        iconSvg: 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83',
        title: 'Kutilayotgan aktivatsiyalar',
        sub: `${pendingCount} ta yangi so‘rov tasdiqlash kutmoqda`,
        tag: 'Shoshilinch',
        tagClass: 'sys-pill-red',
        onClick: () => showView('activations')
      });
    }

    if (summary.recentSyncAt) {
      const syncDate = new Date(summary.recentSyncAt);
      const diffMs = Date.now() - syncDate.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours >= 1) {
        items.push({
          iconType: 'orange',
          iconSvg: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
          title: 'Sinxronlash holati',
          sub: `${diffHours} soatdan beri sinxronlanmadi`,
          tag: 'Kechikish',
          tagClass: 'sys-pill-orange',
          onClick: () => showView('system')
        });
      }
    }

    const totalWorkers = Number(summary.workers || 0);
    const boundWorkers = Number(summary.workerBindings || 0);
    if (totalWorkers > 0 && boundWorkers < totalWorkers * 0.5) {
      const pct = Math.round((boundWorkers / totalWorkers) * 100);
      items.push({
        iconType: 'blue',
        iconSvg: 'm22 2-7 20-4-9-9-4Z',
        title: 'Telegram identifikatsiyasi',
        sub: `Ishchilarning faqat ${pct}% ulangan (${boundWorkers} / ${totalWorkers})`,
        tag: 'Past',
        tagClass: 'sys-pill-orange',
        onClick: () => showView('bindings')
      });
    }

    const activeParties = Number(summary.parties || 0);
    if (activeParties > 0) {
      items.push({
        iconType: 'amber',
        iconSvg: 'm7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
        title: 'Yopilmagan partiyalar',
        sub: `${number(activeParties)} ta partiya jarayonda`,
        tag: 'Faol',
        tagClass: 'sys-pill-amber',
        onClick: () => showView('parties')
      });
    }

    if (badge) badge.textContent = String(items.length);

    if (items.length === 0) {
      feed.appendChild(node('p', 'empty-state', 'Diqqat talab qiluvchi muammolar yo‘q · Barcha xizmatlar barqaror.'));
      return;
    }

    for (const item of items) {
      const alertItem = node('div', 'sys-alert-item');
      if (item.onClick) alertItem.onclick = item.onClick;
      const iconWrap = node('div', `sys-alert-icon sys-alert-icon-${item.iconType}`);
      iconWrap.appendChild(svgIcon(item.iconSvg, 18));
      alertItem.appendChild(iconWrap);

      const body = node('div', 'sys-alert-body');
      body.appendChild(node('strong', 'sys-alert-title', item.title));
      body.appendChild(node('span', 'sys-alert-sub', item.sub));
      alertItem.appendChild(body);

      const tag = node('span', `sys-pill-tag ${item.tagClass}`, item.tag);
      alertItem.appendChild(tag);
      feed.appendChild(alertItem);
    }
  }

  function renderSysActiveCompanies() {
    const feed = byId('sysActiveCompaniesFeed');
    if (!feed) return;
    feed.replaceChildren();
    if (!state.companies || !state.companies.length) {
      feed.appendChild(node('p', 'empty-state', 'Ro‘yxatdan o‘tgan korxonalar yo‘q.'));
      return;
    }
    const activeCompanies = state.companies.slice(0, 3);
    const avatars = ['sys-avatar-t', 'sys-avatar-b', 'sys-avatar-s'];
    const maxWorkers = Math.max(...activeCompanies.map((c) => Number(c.workerCount || 0)), 50);
    activeCompanies.forEach((co, idx) => {
      const item = node('div', 'sys-company-item');
      item.dataset.openCompany = co.companyId;
      item.onclick = () => openCompanyProfile(co.companyId);
      const avatarClass = avatars[idx % avatars.length];
      const letter = (co.companyName || co.companyId || 'K').trim().charAt(0).toUpperCase();
      const av = node('div', `sys-co-avatar ${avatarClass}`, letter);
      item.appendChild(av);
      const details = node('div', 'sys-co-details');
      const metaTop = node('div', 'sys-co-meta-top');
      metaTop.appendChild(node('strong', 'sys-co-name', co.companyName || co.companyId));
      details.appendChild(metaTop);
      const workers = Number(co.workerCount || 0);
      details.appendChild(node('span', 'sys-co-stats', `${number(workers)} ishchi · ${number(co.modelCount || 0)} model`));
      const track = node('div', 'sys-progress-track');
      const fill = node('div', 'sys-progress-fill');
      const pct = Math.min(100, Math.max(10, Math.round((workers / maxWorkers) * 100)));
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      details.appendChild(track);
      item.appendChild(details);
      feed.appendChild(item);
    });
  }

  async function loadDevices() {
    const result = await request(`${API}/devices`);
    const allRegistered = result.devices.registered || [];
    state.devices = allRegistered;

    setText('devicesCountBadge', number(allRegistered.length));

    // Filter by chip and search
    let registered = allRegistered;
    if (state.deviceFilter === 'online') {
      registered = registered.filter((d) => !d.revoked);
    } else if (state.deviceFilter === 'offline') {
      registered = registered.filter((d) => d.revoked);
    }

    const query = String(state.deviceSearchQuery || '').trim().toLowerCase();
    if (query) {
      registered = registered.filter((d) =>
        (d.deviceId && d.deviceId.toLowerCase().includes(query)) ||
        (d.companyId && d.companyId.toLowerCase().includes(query)) ||
        (d.clientVersion && d.clientVersion.toLowerCase().includes(query))
      );
    }

    const registeredBody = tableMessage('registeredDeviceRows', 'registeredDeviceEmpty', allRegistered);
    for (const item of allRegistered) {
      const row = node('tr');
      cell(row, item.deviceId, 'mono');
      cell(row, item.companyId, 'mono');
      cell(row, item.clientVersion);
      const status = node('td');
      status.appendChild(statusBadge(item.revoked ? 'REVOKED' : 'ACTIVE'));
      row.appendChild(status);
      cell(row, timestamp(item.registeredAt));
      registeredBody.appendChild(row);
    }

    const deviceGrid = byId('deviceCardGrid');
    if (deviceGrid) {
      deviceGrid.replaceChildren();
      if (!registered.length) {
        deviceGrid.appendChild(node('p', 'empty-state', 'Qurilma topilmadi.'));
      } else {
        for (const item of registered) {
          const card = node('article', 'device-touch-card');
          const top = node('div', 'party-touch-card-top');
          const leftWrap = node('div', 'device-meta-left');
          const title = node('strong', 'device-name-title', item.deviceId);
          const sub = node('span', 'device-sub-text', `${item.companyId || 'Korxona'} · Versiya: ${item.clientVersion || '1.0.0'}`);
          leftWrap.appendChild(title);
          leftWrap.appendChild(sub);
          top.appendChild(leftWrap);

          const isOnline = !item.revoked;
          const statusPill = node('span', `sys-pill-tag ${isOnline ? 'sys-pill-green' : 'sys-pill-gray'}`, isOnline ? '● Onlayn' : '● Oflayn');
          top.appendChild(statusPill);
          card.appendChild(top);

          const timeRow = node('div', 'device-time-row');
          timeRow.appendChild(node('time', 'mono muted', `Ro‘yxatdan o‘tgan: ${timestamp(item.registeredAt)}`));
          card.appendChild(timeRow);

          deviceGrid.appendChild(card);
        }
      }
    }

    const activationRows = result.devices.activationRequests || [];
    const activationBody = tableMessage('deviceActivationRows', 'deviceActivationEmpty', activationRows);
    for (const item of activationRows) {
      const row = node('tr');
      cell(row, item.machineId, 'mono');
      const status = node('td'); status.appendChild(statusBadge(item.status)); row.appendChild(status);
      cell(row, item.companyName || item.companyId || '—');
      cell(row, item.role || '—');
      cell(row, timestamp(item.requestedAt));
      activationBody.appendChild(row);
    }
  }

  function refreshCompanySelectors() {
    const choices = state.companies || [];
    const policySelect = byId('companyPolicySelect');
    const currentPolicyValue = policySelect.value;
    policySelect.replaceChildren(node('option', '', 'Mavjud korxonani tanlang'));
    for (const company of choices.filter((item) => item.businessScopeExists)) {
      const option = node('option', '', `${company.companyName} · ${company.companyId}`);
      option.value = company.companyId;
      policySelect.appendChild(option);
    }
    if ([...policySelect.options].some((item) => item.value === currentPolicyValue)) policySelect.value = currentPolicyValue;
    else if (!state.access?.isGlobalAdmin && state.access?.companyIds?.length === 1) {
      policySelect.value = state.access.companyIds[0];
      policySelect.dispatchEvent(new Event('change'));
    }

    const companySelect = byId('activationCompanySelect');
    const currentValue = companySelect.value;
    companySelect.replaceChildren(node('option', '', 'Kompaniyani tanlang'));
    for (const company of choices.filter((item) => item.businessScopeExists && item.activationConfigured && item.activationActive)) {
      const option = node('option', '', `${company.companyName} · ${company.companyId}`);
      option.value = company.companyId;
      companySelect.appendChild(option);
    }
    if ([...companySelect.options].some((item) => item.value === currentValue)) companySelect.value = currentValue;
    else if (!state.access?.isGlobalAdmin && state.access?.companyIds?.length === 1) companySelect.value = state.access.companyIds[0];

    const balanceSelect = byId('balanceCompanySelect');
    if (balanceSelect) {
      const selectedBalance = balanceSelect.value;
      balanceSelect.replaceChildren(node('option', '', 'Biznes scope tanlang'));
      for (const company of choices.filter((item) => item.businessScopeExists)) {
        const option = node('option', '', `${company.companyName} · ${company.companyId}`);
        option.value = company.companyId;
        balanceSelect.appendChild(option);
      }
      if ([...balanceSelect.options].some((item) => item.value === selectedBalance)) balanceSelect.value = selectedBalance;
      else if (!state.access?.isGlobalAdmin && state.access?.companyIds?.length === 1) balanceSelect.value = state.access.companyIds[0];
    }

    const adminSelect = byId('companyAdminCompany');
    if (adminSelect) {
      const selectedAdminCompany = adminSelect.value;
      adminSelect.replaceChildren(node('option', '', 'Kompaniyani tanlang'));
      for (const company of choices.filter((item) => item.businessScopeExists)) {
        const option = node('option', '', `${company.companyName} · ${company.companyId}`);
        option.value = company.companyId;
        adminSelect.appendChild(option);
      }
      if ([...adminSelect.options].some((item) => item.value === selectedAdminCompany)) adminSelect.value = selectedAdminCompany;
    }
  }

  async function loadCompanies() {
    const result = await request(`${API}/companies`);
    state.companies = result.companies || [];
    refreshCompanySelectors();
    renderCompanyCards();
    byId('companyAdminManagement').hidden = !state.access?.isGlobalAdmin;
    const tbody = tableMessage('companyRows', 'companyEmpty', state.companies);
    for (const company of state.companies) {
      const row = node('tr');
      cell(row, company.companyId, 'mono', 'ID');
      cell(row, company.companyName, '', 'Nomi');
      cell(row, number(company.workerCount), '', 'Ishchi');
      cell(row, number(company.modelCount), '', 'Model');
      cell(row, number(company.partyCount), '', 'Partiya');
      cell(row, (company.availableSizes || []).join(', ') || '—', '', 'O‘lchamlar');
      cell(row, company.serverRevision ?? '—', '', 'Reviziya');
      const configured = node('td');
      configured.dataset.label = 'Aktivatsiya';
      configured.appendChild(statusBadge(!company.activationConfigured ? 'UNCONFIGURED' : company.activationActive ? 'ACTIVE' : 'INACTIVE'));
      row.appendChild(configured);
      cell(row, company.allowedRoles?.length ? company.allowedRoles.join(', ') : '—', '', 'Ruxsatlar');
      cell(row, company.requireTicketValidation == null ? '—' : company.requireTicketValidation ? 'Talab qilinadi' : 'Ixtiyoriy', '', 'Patta');
      const actionCell = node('td');
      actionCell.className = 'actions-cell';
      if (company.businessScopeExists) {
        const viewBtn = node('button', 'small-action button-accent-action', 'Boshqaruv');
        viewBtn.type = 'button';
        viewBtn.dataset.openCompany = company.companyId;
        actionCell.appendChild(viewBtn);
        const editBtn = node('button', 'small-action', 'Siyosat');
        editBtn.type = 'button';
        editBtn.dataset.editCompany = company.companyId;
        actionCell.appendChild(editBtn);
      }
      row.appendChild(actionCell);
      tbody.appendChild(row);
    }
    if (state.access?.isGlobalAdmin) {
      const companyId = byId('companyAdminCompany').value || state.companies.find((company) => company.businessScopeExists)?.companyId;
      if (companyId) {
        byId('companyAdminCompany').value = companyId;
        await loadCompanyAdmins(companyId);
      }
    }
  }

  function renderCompanyCards() {
    const grid = byId('companyCardGrid');
    if (!grid) return;
    grid.replaceChildren();

    let items = state.companies || [];
    const filter = state.companyFilter || 'all';
    if (filter === 'active') {
      items = items.filter((c) => c.activationActive);
    } else if (filter === 'unconfigured') {
      items = items.filter((c) => !c.activationConfigured);
    }

    const query = String(state.companySearchQuery || '').trim().toLowerCase();
    if (query) {
      items = items.filter((c) =>
        (c.companyName && c.companyName.toLowerCase().includes(query)) ||
        (c.companyId && c.companyId.toLowerCase().includes(query))
      );
    }

    if (!items.length) {
      const empty = node('p', 'empty-state', 'Qidiruv bo‘yicha korxona topilmadi.');
      grid.appendChild(empty);
      return;
    }

    for (const company of items) {
      const card = node('article', 'company-card touch-card');
      card.dataset.companyId = company.companyId;

      const header = node('div', 'company-card-header');
      const badgeIcon = node('div', 'company-badge-icon', (company.companyName || 'K').charAt(0).toUpperCase());
      const info = node('div', 'company-card-info');
      const name = node('h3', 'company-name', company.companyName || company.companyId);
      const idLabel = node('span', 'company-id mono', `ID: ${company.companyId}`);
      info.appendChild(name);
      info.appendChild(idLabel);
      header.appendChild(badgeIcon);
      header.appendChild(info);
      header.appendChild(statusBadge(!company.activationConfigured ? 'UNCONFIGURED' : company.activationActive ? 'ACTIVE' : 'INACTIVE'));
      card.appendChild(header);

      const chips = node('div', 'company-stat-chips');
      const addChip = (label, val) => {
        const chip = node('div', 'stat-chip');
        chip.appendChild(node('span', 'chip-label', label));
        chip.appendChild(node('strong', 'chip-value', val));
        chips.appendChild(chip);
      };
      addChip('Ishchi', number(company.workerCount));
      addChip('Model', number(company.modelCount));
      addChip('Partiya', number(company.partyCount));
      addChip('Aktivatsiya', company.activationConfigured ? (company.activationActive ? 'Faol' : 'Nofaol') : 'Yo‘q');
      card.appendChild(chips);

      const footer = node('div', 'company-card-footer');
      const openBtn = node('button', 'button button-primary company-open-button', 'Boshqaruv paneli ➔');
      openBtn.type = 'button';
      openBtn.dataset.openCompany = company.companyId;
      footer.appendChild(openBtn);
      card.appendChild(footer);

      grid.appendChild(card);
    }
  }

  async function openCompanyProfile(companyId) {
    if (!companyId) return;
    state.selectedCompanyId = companyId;
    state.currentCpTab = 'overview';
    showView('overview');
  }

  async function loadCompanyProfile(companyId = state.selectedCompanyId) {
    if (!companyId) return;
    state.selectedCompanyId = companyId;
    let company = state.companies.find((c) => c.companyId === companyId);
    if (!company) {
      const res = await request(`${API}/companies`);
      state.companies = res.companies || [];
      company = state.companies.find((c) => c.companyId === companyId);
    }
    if (!company) return;

    setText('cpAvatar', (company.companyName || 'K').charAt(0).toUpperCase());
    setText('cpCompanyName', company.companyName || company.companyId);
    setText('cpCompanyId', `ID: ${company.companyId}`);
    const badge = byId('cpStatusBadge');
    if (badge) {
      badge.textContent = company.activationActive ? 'Faol' : 'Nofaol';
      badge.className = `badge ${company.activationActive ? 'badge-active' : 'badge-inactive'}`;
    }
    setText('cpStatWorkers', number(company.workerCount));
    setText('cpStatModels', number(company.modelCount));
    setText('cpStatParties', number(company.partyCount));
    const devCount = (state.devices || []).filter((d) => d.companyId === company.companyId).length;
    setText('cpStatDevices', devCount > 0 ? number(devCount) : '0');

    setText('cpFactId', company.companyId);
    setText('cpFactActivation', !company.activationConfigured ? 'Sozlanmagan' : company.activationActive ? 'Faol' : 'Nofaol');
    setText('cpFactRoles', company.allowedRoles?.length ? company.allowedRoles.join(', ') : 'Belgilanmagan');
    setText('cpFactTicketVal', company.requireTicketValidation == null ? '—' : company.requireTicketValidation ? 'Talab qilinadi' : 'Ixtiyoriy');
    setText('cpFactSizes', (company.availableSizes || []).join(', ') || '—');
    setText('cpFactRevision', company.serverRevision ?? '—');
    setText('cpLastSync', company.serverRevisionAt ? timestamp(company.serverRevisionAt) : (company.updatedAt ? timestamp(company.updatedAt) : (company.serverRevision ? `Rev #${company.serverRevision}` : '—')));

    const policyComp = byId('cpPolicyCompanyHidden');
    if (policyComp) policyComp.value = company.companyId;
    const policyName = byId('cpPolicyNameInput');
    if (policyName) policyName.value = company.companyName || '';
    const policyActive = byId('cpPolicyActiveInput');
    if (policyActive) policyActive.checked = Boolean(company.activationActive);

    const adminComp = byId('cpAdminCompanyHidden');
    if (adminComp) adminComp.value = company.companyId;

    await switchCpTab(state.currentCpTab || 'overview');
  }

  async function switchCpTab(tabName) {
    if (tabName === 'overview') {
      showView('overview');
      return;
    }
    state.currentCpTab = tabName;
    for (const btn of document.querySelectorAll('#cpTabs .profile-tab')) {
      btn.classList.toggle('is-active', btn.dataset.cpTab === tabName);
    }
    for (const pane of document.querySelectorAll('.cp-pane')) {
      const isCurrent = pane.id === `pane-cp-${tabName}`;
      pane.hidden = !isCurrent;
      pane.classList.toggle('is-visible', isCurrent);
    }

    const companyId = state.selectedCompanyId;
    if (!companyId) return;

    if (tabName === 'workers') {
      await loadCpWorkers(companyId);
    } else if (tabName === 'parties') {
      await loadCpParties(companyId);
    } else if (tabName === 'models') {
      await loadCpModels(companyId);
    } else if (tabName === 'devices') {
      await loadCpDevices(companyId);
    } else if (tabName === 'admins') {
      await loadCpAdmins(companyId);
    }
  }

  async function loadCpWorkers(companyId) {
    const list = byId('cpWorkerCardList');
    if (!list) return;
    list.replaceChildren();
    try {
      const res = await request(withQuery(`${API}/workers`, { companyId, limit: 100 }));
      state.currentCpWorkers = res.workers || [];
      renderCpWorkerCards();
    } catch (err) {
      toast(`Ishchilar yuklanmadi: ${err.code || 'API_UNAVAILABLE'}`);
    }
  }

  function renderCpWorkerCards() {
    const list = byId('cpWorkerCardList');
    if (!list) return;
    list.replaceChildren();
    let workers = state.currentCpWorkers || [];
    const query = String(state.cpWorkerSearchQuery || '').trim().toLowerCase();
    if (query) {
      workers = workers.filter((w) =>
        (w.name && w.name.toLowerCase().includes(query)) ||
        String(w.workerId).includes(query) ||
        (w.role && w.role.toLowerCase().includes(query))
      );
    }
    setText('cpWorkerCount', `${workers.length} ta`);
    byId('cpWorkerEmpty').hidden = workers.length > 0;
    const companyId = state.selectedCompanyId;
    for (const w of workers) {
      const card = node('article', 'worker-touch-card');
      const top = node('div', 'worker-touch-card-top');
      const left = node('div', 'worker-card-left');
      const letter = (w.name || 'I').trim().charAt(0).toUpperCase();
      const av = node('div', 'sys-co-avatar sys-avatar-t', letter);
      left.appendChild(av);

      const nameWrap = node('div', 'worker-name-block');
      nameWrap.appendChild(node('strong', 'worker-touch-title', w.name));
      nameWrap.appendChild(node('span', 'worker-role-sub', `${w.role ? `${w.role} · ` : ''}ID ${w.workerId}`));
      left.appendChild(nameWrap);
      top.appendChild(left);

      const isBound = Boolean(w.binding);
      const boundBadge = node('span', `sys-pill-tag ${isBound ? 'sys-pill-green' : 'sys-pill-gray'}`, isBound ? '● Ulangan' : '● Ulanmagan');
      top.appendChild(boundBadge);
      card.appendChild(top);

      const stats = node('div', 'worker-touch-stats');
      stats.appendChild(node('span', '', `Staj: ${money(w.staj)}`));
      if (w.binding) {
        stats.appendChild(node('span', 'mono muted', w.binding.username ? `@${w.binding.username}` : `ID: ${w.binding.telegramId}`));
      }
      card.appendChild(stats);

      const actions = node('div', 'worker-touch-actions');
      const adjBtn = node('button', 'button button-primary button-sm', '💵 + Avans');
      adjBtn.type = 'button';
      adjBtn.dataset.quickAdj = String(w.workerId);
      adjBtn.dataset.companyId = companyId;
      adjBtn.dataset.workerName = w.name;
      actions.appendChild(adjBtn);

      const editBtn = node('button', 'button button-secondary button-sm', '✏️ Tahrirlash');
      editBtn.type = 'button';
      editBtn.dataset.editWorker = String(w.workerId);
      editBtn.dataset.companyId = companyId;
      actions.appendChild(editBtn);

      if (w.binding) {
        const unbindBtn = node('button', 'button button-danger button-sm', '🔗 Yechish');
        unbindBtn.type = 'button';
        unbindBtn.dataset.unbindWorker = String(w.workerId);
        unbindBtn.dataset.companyId = companyId;
        unbindBtn.dataset.telegramId = w.binding.telegramId;
        unbindBtn.dataset.workerName = w.name;
        actions.appendChild(unbindBtn);
      }
      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  async function loadCpParties(companyId) {
    const list = byId('cpPartyCardList');
    if (!list) return;
    list.replaceChildren();
    try {
      const res = await request(withQuery(`${API}/parties`, { companyId, limit: 100 }));
      const parties = res.parties || [];
      setText('cpPartyCount', `${parties.length} ta`);
      byId('cpPartyEmpty').hidden = parties.length > 0;
      for (const p of parties) {
        const card = node('article', 'party-touch-card');
        const top = node('div', 'party-touch-card-top');
        const titleWrap = node('div', 'party-title-wrap');
        titleWrap.appendChild(node('strong', 'party-touch-title', `Partiya № ${p.partyNumber}`));
        titleWrap.appendChild(node('span', 'party-model-sub', p.modelName || 'Model belgilanmagan'));
        top.appendChild(titleWrap);
        top.appendChild(statusBadge(p.status));
        card.appendChild(top);

        const ishSoni = Number(p.ishSoni || 0);
        const pattaCount = Number(p.pattaCount || 0);
        const percent = pattaCount > 0 ? Math.min(100, Math.round((ishSoni / pattaCount) * 100)) : 0;

        const progressInfo = node('div', 'worker-touch-stats');
        progressInfo.appendChild(node('span', '', `Tikilgan: ${number(ishSoni)} / ${number(pattaCount)} dona`));
        progressInfo.appendChild(node('span', 'mono', `${percent}% bajarildi`));
        card.appendChild(progressInfo);

        const progressWrap = node('div', 'batch-progress-bar');
        const fill = node('div', 'batch-progress-fill');
        fill.style.width = `${percent}%`;
        progressWrap.appendChild(fill);
        card.appendChild(progressWrap);

        const footer = node('div', 'device-time-row');
        footer.appendChild(node('time', 'mono muted', `Yangilangan: ${timestamp(p.updatedAt)}`));
        card.appendChild(footer);

        list.appendChild(card);
      }
    } catch (err) {
      toast(`Partiyalar yuklanmadi: ${err.code || 'API_UNAVAILABLE'}`);
    }
  }

  async function loadCpModels(companyId) {
    const list = byId('cpModelCardList');
    if (!list) return;
    list.replaceChildren();
    try {
      const res = await request(withQuery(`${API}/models`, { companyId, limit: 100 }));
      const models = res.models || [];
      setText('cpModelCount', `${models.length} ta`);
      byId('cpModelEmpty').hidden = models.length > 0;
      for (const m of models) {
        const card = node('article', 'model-touch-card');
        const top = node('div', 'party-touch-card-top');
        const leftWrap = node('div', 'model-meta-left');
        leftWrap.appendChild(node('strong', 'party-touch-title', m.name));
        top.appendChild(leftWrap);

        const rateSum = (m.operations || []).reduce((s, op) => s + Number(op.rate || 0), 0);
        top.appendChild(node('span', 'sys-pill-tag sys-pill-green', `● ${number(rateSum)} so‘m`));
        card.appendChild(top);

        const ops = m.operations || [];
        const meta = node('div', 'worker-touch-stats');
        meta.appendChild(node('span', '', `Ratsenka summasi: ${number(rateSum)} so‘m`));
        meta.appendChild(node('span', 'mono muted', `Amallar: ${ops.length} ta`));
        card.appendChild(meta);

        if (m.availableSizes && m.availableSizes.length > 0) {
          card.appendChild(node('div', 'count-label', `O‘lchamlar: ${m.availableSizes.join(', ')}`));
        }
        list.appendChild(card);
      }
    } catch (err) {
      toast(`Modellar yuklanmadi: ${err.code || 'API_UNAVAILABLE'}`);
    }
  }

  async function loadCpDevices(companyId) {
    const list = byId('cpDeviceCardList');
    if (!list) return;
    list.replaceChildren();
    try {
      const res = await request(withQuery(`${API}/devices`, { companyId }));
      const registered = res.devices?.registered || [];
      setText('cpDeviceCount', `${registered.length} ta`);
      setText('cpStatDevices', number(registered.length));
      byId('cpDeviceEmpty').hidden = registered.length > 0;
      for (const d of registered) {
        const card = node('article', 'device-touch-card');
        const top = node('div', 'party-touch-card-top');
        const leftWrap = node('div', 'device-meta-left');
        leftWrap.appendChild(node('strong', 'device-name-title mono', d.deviceId));
        leftWrap.appendChild(node('span', 'device-sub-text', `Versiya: ${d.clientVersion || '1.0.0'}`));
        top.appendChild(leftWrap);

        const isOnline = !d.revoked;
        const statusPill = node('span', `sys-pill-tag ${isOnline ? 'sys-pill-green' : 'sys-pill-gray'}`, isOnline ? '● Onlayn' : '● Oflayn');
        top.appendChild(statusPill);
        card.appendChild(top);

        const timeRow = node('div', 'device-time-row');
        timeRow.appendChild(node('time', 'mono muted', `Ro‘yxatdan o‘tgan: ${timestamp(d.registeredAt)}`));
        card.appendChild(timeRow);

        list.appendChild(card);
      }
    } catch (err) {
      toast(`Qurilmalar yuklanmadi: ${err.code || 'API_UNAVAILABLE'}`);
    }
  }

  async function loadCpAdmins(companyId) {
    await loadCompanyAdmins(companyId);
    const mainRows = byId('companyAdminRows');
    const cpRows = byId('cpAdminRows');
    if (mainRows && cpRows && mainRows !== cpRows) {
      cpRows.replaceChildren(...[...mainRows.children].map((c) => c.cloneNode(true)));
      byId('cpAdminEmpty').hidden = byId('companyAdminEmpty').hidden;
    }
  }

  async function openQuickAdjustment(params = {}) {
    const { workerId, companyId, workerName } = params;
    const dialog = byId('quickAdjustmentDialog');
    if (!dialog) return;

    const cid = companyId || state.selectedCompanyId || state.access?.companyIds?.[0] || '';
    byId('quickAdjCompanyId').value = cid;
    setText('quickAdjCompanyLabel', `Kompaniya: ${cid}`);
    byId('quickAdjAmount').value = '';
    byId('quickAdjDescription').value = '';

    const badge = byId('quickAdjWorkerBadge');
    const selectWrap = byId('quickAdjWorkerSelectWrap');
    const workerSelect = byId('quickAdjWorkerSelect');

    if (workerId) {
      byId('quickAdjWorkerId').value = workerId;
      setText('quickAdjWorkerName', workerName || `#${workerId}`);
      if (badge) badge.hidden = false;
      if (selectWrap) selectWrap.hidden = true;
    } else {
      byId('quickAdjWorkerId').value = '';
      if (badge) badge.hidden = true;
      if (selectWrap) selectWrap.hidden = false;
      if (workerSelect) {
        workerSelect.replaceChildren(node('option', '', 'Ishchilar yuklanmoqda…'));
        try {
          const res = await request(withQuery(`${API}/workers`, { companyId: cid, limit: 100 }));
          const activeWorkers = (res.workers || []).filter((w) => w.status === 'ACTIVE');
          workerSelect.replaceChildren(node('option', '', activeWorkers.length ? 'Ishchini tanlang' : 'Faol ishchi topilmadi'));
          for (const w of activeWorkers) {
            const opt = node('option', '', `${w.name} (#${w.workerId})`);
            opt.value = w.workerId;
            workerSelect.appendChild(opt);
          }
          workerSelect.onchange = () => {
            byId('quickAdjWorkerId').value = workerSelect.value;
          };
        } catch {
          workerSelect.replaceChildren(node('option', '', 'Ishchilarni yuklab bo‘lmadi'));
        }
      }
    }

    const periodSelect = byId('quickAdjPeriodSelect');
    periodSelect.replaceChildren(node('option', '', 'Ochiq davr yuklanmoqda…'));
    try {
      const res = await request(`${API}/companies/${encodeURIComponent(cid)}/periods`);
      const periods = (res.periods || []).filter((p) => !p.isClosed);
      periodSelect.replaceChildren();
      if (!periods.length) {
        periodSelect.appendChild(node('option', '', 'Ochiq davr mavjud emas'));
      } else {
        for (const p of periods) {
          const opt = node('option', '', `${p.name} · ${p.startDate}${p.endDate ? ` — ${p.endDate}` : ''}`);
          opt.value = p.periodId;
          periodSelect.appendChild(opt);
        }
      }
    } catch {
      periodSelect.replaceChildren(node('option', '', 'Davrlarni yuklab bo‘lmadi'));
    }

    dialog.showModal();
    try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
  }

  async function submitQuickAdjustment(event) {
    event.preventDefault();
    const form = byId('quickAdjustmentForm');
    const data = new FormData(form);
    const workerId = Number(data.get('workerId') || byId('quickAdjWorkerSelect')?.value);
    const companyId = String(data.get('companyId') || '').trim();
    const type = String(data.get('type') || 'AVANS').toUpperCase();
    const periodId = String(data.get('periodId') || '').trim();
    const amountDelta = Number(data.get('amountDelta') || 0);
    const description = String(data.get('description') || '').trim();

    if (!companyId || !workerId || !periodId || !amountDelta || amountDelta <= 0 || !description) {
      toast('Barcha maydonlarni to‘ldiring.');
      return;
    }

    const button = byId('submitQuickAdj');
    button.disabled = true;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyId)}/workers/${encodeURIComponent(workerId)}`, {
        method: 'POST',
        body: {
          adjustment: {
            adjustmentId: crypto.randomUUID(),
            type,
            periodId,
            amountDelta,
            description
          }
        }
      });
      byId('quickAdjustmentDialog').close();
      toast(`${type === 'AVANS' ? 'Avans' : 'Jarima'} saqlandi va sync qilindi.`);
      try { telegram?.HapticFeedback?.notificationOccurred?.('success'); } catch { }
      if (state.currentView === 'company-profile') {
        await switchCpTab('workers');
      } else if (state.currentView === 'workers') {
        await loadWorkers(state.workerFilters);
      } else if (state.currentView === 'overview') {
        await loadOverview();
      }
    } catch (error) {
      toast(`Saqlanmadi: ${error.code || 'API_UNAVAILABLE'}`);
      try { telegram?.HapticFeedback?.notificationOccurred?.('error'); } catch { }
    } finally {
      button.disabled = false;
    }
  }

  async function loadCompanyAdmins(companyId) {
    const result = await request(`${API}/companies/${encodeURIComponent(companyId)}/admins`);
    state.companyAdmins = result.admins || [];
    const container = byId('companyAdminRows');
    container.replaceChildren();
    byId('companyAdminEmpty').hidden = state.companyAdmins.length > 0;
    for (const admin of state.companyAdmins) {
      const item = node('div', 'access-item');
      const identity = node('div');
      identity.appendChild(node('strong', '', admin.telegramId));
      identity.appendChild(node('div', 'count-label', `${admin.isActive ? 'Faol' : 'Bekor qilingan'} · ${admin.source || '—'}`));
      item.appendChild(identity);
      const action = node('button', admin.isActive ? 'small-action button-danger' : 'small-action button-accent-action', admin.isActive ? 'Bekor qilish' : 'Qayta faollashtirish');
      action.type = 'button';
      action.dataset.companyAdminId = admin.telegramId;
      action.dataset.companyId = companyId;
      action.dataset.active = String(!admin.isActive);
      item.appendChild(action);
      container.appendChild(item);
    }
  }

  async function loadOpenPeriods(companyId) {
    const select = byId('workerAdjustmentPeriod');
    const result = await request(`${API}/companies/${encodeURIComponent(companyId)}/periods`);
    const form = byId('workerEditForm');
    if (!byId('workerDialog').open || form.elements.companyId.value !== companyId) return;
    const periods = (result.periods || []).filter((period) => !period.isClosed);
    select.replaceChildren(node('option', '', periods.length ? 'Ochiq davrni tanlang' : 'Ochiq davr mavjud emas'));
    for (const period of periods) {
      const option = node('option', '', `${period.name} · ${period.startDate}${period.endDate ? ` — ${period.endDate}` : ''}`);
      option.value = period.periodId;
      select.appendChild(option);
    }
    select.disabled = periods.length === 0;
  }

  async function submitCompanyAdmin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const companyId = String(data.get('companyId') || '').trim();
    const telegramId = String(data.get('telegramId') || '').trim();
    if (!companyId || !/^\d{1,24}$/.test(telegramId)) { toast('Kompaniya va to‘g‘ri Telegram ID kiriting.'); return; }
    let granted = false;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyId)}/admins/${encodeURIComponent(telegramId)}`, {
        method: 'PUT', body: { isActive: true }
      });
      form.elements.telegramId.value = '';
      granted = true;
      toast('Kompaniya admini saqlandi.');
    } catch (error) { toast(`Admin saqlanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    if (granted) {
      try { await loadCompanyAdmins(companyId); }
      catch (error) { toast(`Admin saqlandi, ro‘yxat yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    }
  }

  async function loadWorkers(filters = state.workerFilters) {
    state.workerFilters = filters;
    const result = await request(withQuery(`${API}/workers`, { ...filters, offset: state.workerOffset, limit: 50 }));
    const workers = result.workers || [];
    state.workers = workers;
    setText('workerHeaderCount', number(result.total || workers.length));
    const workerRangeStart = result.total ? result.offset + 1 : 0;
    setText('workerCount', `${number(result.total)} ta · ${number(workerRangeStart)}–${number(Math.min(result.offset + workers.length, result.total))}`);
    setText('workerPage', `${number(workerRangeStart)}–${number(Math.min(result.offset + workers.length, result.total))} / ${number(result.total)}`);
    byId('workerPrevious').disabled = result.offset === 0;
    byId('workerNext').disabled = result.offset + workers.length >= result.total;
    const tbody = tableMessage('workerRows', 'workerEmpty', workers);
    for (const worker of workers) {
      const row = node('tr');
      cell(row, `#${worker.workerId}`, 'mono', 'ID');
      cell(row, worker.name, '', 'Ism');
      cell(row, worker.companyId, 'mono', 'Korxona');
      const status = node('td'); status.dataset.label = 'Holat'; status.appendChild(statusBadge(worker.status)); row.appendChild(status);
      cell(row, money(worker.staj), '', 'Staj');
      cell(row, worker.binding ? `${worker.binding.username ? `@${worker.binding.username} · ` : ''}${worker.binding.telegramId}` : 'Bog‘lanmagan', 'mono', 'Telegram');
      const actionCell = node('td');
      actionCell.className = 'actions-cell';
      const adjBtn = node('button', 'small-action button-accent-action', '+ Avans');
      adjBtn.type = 'button';
      adjBtn.dataset.quickAdj = String(worker.workerId);
      adjBtn.dataset.companyId = worker.companyId;
      adjBtn.dataset.workerName = worker.name;
      actionCell.appendChild(adjBtn);
      const edit = node('button', 'small-action', 'Tahrirlash');
      edit.type = 'button';
      edit.dataset.editWorker = worker.workerId;
      edit.dataset.companyId = worker.companyId;
      actionCell.appendChild(edit);
      if (worker.binding) {
        const unbind = node('button', 'small-action button-danger', 'Bog‘lanishni yechish');
        unbind.type = 'button';
        unbind.dataset.unbindWorker = worker.workerId;
        unbind.dataset.companyId = worker.companyId;
        unbind.dataset.telegramId = worker.binding.telegramId;
        unbind.dataset.workerName = worker.name;
        actionCell.appendChild(unbind);
      }
      row.appendChild(actionCell);
      tbody.appendChild(row);
    }

    const cardGrid = byId('workerCardGrid');
    if (cardGrid) {
      cardGrid.replaceChildren();

      let displayWorkers = workers;
      if (state.workerFilter === 'active') {
        displayWorkers = displayWorkers.filter((w) => w.status === 'ACTIVE');
      } else if (state.workerFilter === 'not_bound') {
        displayWorkers = displayWorkers.filter((w) => !w.binding);
      }

      const q = String(state.workerSearchQuery || '').trim().toLowerCase();
      if (q) {
        displayWorkers = displayWorkers.filter((w) =>
          (w.name && w.name.toLowerCase().includes(q)) ||
          String(w.workerId).includes(q) ||
          (w.role && w.role.toLowerCase().includes(q))
        );
      }

      if (!displayWorkers.length) {
        cardGrid.appendChild(node('p', 'empty-state', 'Ishchilar topilmadi.'));
      } else {
        for (const worker of displayWorkers) {
          const card = node('article', 'worker-touch-card');
          card.onclick = (e) => {
            if (e.target.closest('button')) return;
            openWorkerDialog(worker.workerId, worker.companyId);
          };

          const top = node('div', 'worker-touch-card-top');
          const left = node('div', 'worker-card-left');
          const letter = (worker.name || 'I').trim().charAt(0).toUpperCase();
          const av = node('div', 'sys-co-avatar sys-avatar-t', letter);
          left.appendChild(av);

          const nameWrap = node('div', 'worker-name-block');
          nameWrap.appendChild(node('strong', 'worker-touch-title', worker.name));
          nameWrap.appendChild(node('span', 'worker-role-sub', `${worker.role ? `${worker.role} · ` : ''}ID ${worker.workerId}`));
          left.appendChild(nameWrap);
          top.appendChild(left);

          const isBound = Boolean(worker.binding);
          const boundBadge = node('span', `sys-pill-tag ${isBound ? 'sys-pill-green' : 'sys-pill-gray'}`, isBound ? '● Ulangan' : '● Ulanmagan');
          top.appendChild(boundBadge);
          card.appendChild(top);

          const meta = node('div', 'worker-touch-stats');
          meta.appendChild(node('span', '', `Staj: ${money(worker.staj)}`));
          if (worker.binding) {
            meta.appendChild(node('span', 'mono muted', worker.binding.username ? `@${worker.binding.username}` : `ID: ${worker.binding.telegramId}`));
          }
          card.appendChild(meta);

          const actions = node('div', 'worker-touch-actions');
          const adjBtn = node('button', 'button button-primary button-sm', '💵 + Avans');
          adjBtn.type = 'button';
          adjBtn.dataset.quickAdj = String(worker.workerId);
          adjBtn.dataset.companyId = worker.companyId;
          adjBtn.dataset.workerName = worker.name;
          actions.appendChild(adjBtn);

          const editBtn = node('button', 'button button-secondary button-sm', '✏️ Tahrirlash');
          editBtn.type = 'button';
          editBtn.onclick = (e) => {
            e.stopPropagation();
            openWorkerDialog(worker.workerId, worker.companyId);
          };
          actions.appendChild(editBtn);
          card.appendChild(actions);

          cardGrid.appendChild(card);
        }
      }
    }
  }

  async function loadBindings() {
    const result = await request(withQuery(`${API}/workers`, { limit: 50, offset: state.bindingOffset, boundOnly: true }));
    const workers = result.workers || [];
    setText('bindingPage', `${number(result.total ? result.offset + 1 : 0)}–${number(Math.min(result.offset + workers.length, result.total))} / ${number(result.total)}`);
    byId('bindingPrevious').disabled = result.offset === 0;
    byId('bindingNext').disabled = result.offset + workers.length >= result.total;
    const body = tableMessage('bindingRows', 'bindingEmpty', workers, 'Telegram bog‘lanishi mavjud emas.');
    for (const worker of workers) {
      const row = node('tr'); cell(row, `#${worker.workerId}`, 'mono'); cell(row, worker.name);
      cell(row, worker.companyId, 'mono');
      const status = node('td'); status.appendChild(statusBadge('BOUND')); row.appendChild(status);
      cell(row, worker.binding.telegramId, 'mono'); cell(row, worker.binding.username ? `@${worker.binding.username}` : '—');
      cell(row, timestamp(worker.binding.linkedAt));
      const actions = node('td');
      const unbind = node('button', 'small-action button-danger', 'Bog‘lanishni yechish');
      unbind.type = 'button';
      unbind.dataset.unbindWorker = worker.workerId;
      unbind.dataset.companyId = worker.companyId;
      unbind.dataset.telegramId = worker.binding.telegramId;
      unbind.dataset.workerName = worker.name;
      actions.appendChild(unbind); row.appendChild(actions); body.appendChild(row);
    }

    const bindingGrid = byId('bindingCardGrid');
    if (bindingGrid) {
      bindingGrid.replaceChildren();
      if (!workers.length) {
        bindingGrid.appendChild(node('p', 'empty-state', 'Telegram bog‘lanishi mavjud emas.'));
      } else {
        for (const worker of workers) {
          const card = node('article', 'worker-touch-card');
          const top = node('div', 'worker-touch-card-top');
          top.appendChild(node('strong', '', `${worker.name} (#${worker.workerId})`));
          top.appendChild(statusBadge('BOUND'));
          card.appendChild(top);

          card.appendChild(node('div', 'count-label', `Telegram ID: ${worker.binding.telegramId}${worker.binding.username ? ` (@${worker.binding.username})` : ''} · Korxona: ${worker.companyId}`));
          card.appendChild(node('time', 'mono muted', `Bog‘langan: ${timestamp(worker.binding.linkedAt)}`));

          const actions = node('div', 'worker-touch-actions');
          const unbind = node('button', 'button button-danger button-sm', 'Bog‘lanishni yechish');
          unbind.type = 'button';
          unbind.dataset.unbindWorker = worker.workerId;
          unbind.dataset.companyId = worker.companyId;
          unbind.dataset.telegramId = worker.binding.telegramId;
          unbind.dataset.workerName = worker.name;
          actions.appendChild(unbind);
          card.appendChild(actions);

          bindingGrid.appendChild(card);
        }
      }
    }
  }

  function openWorkerDialog(workerId, companyId) {
    const worker = state.workers.find((item) => String(item.workerId) === String(workerId) && item.companyId === companyId);
    if (!worker) { toast('Ishchi ro‘yxati eskirgan. Yangilang.'); return; }
    const form = byId('workerEditForm');
    form.elements.workerId.value = worker.workerId;
    form.elements.companyId.value = worker.companyId;
    form.elements.baseRevision.value = worker.serverRevision;
    form.elements.name.value = worker.name || '';
    form.elements.role.value = worker.role || '';
    form.elements.staj.value = worker.staj ?? 0;
    form.elements.adjustmentType.value = '';
    form.elements.periodId.replaceChildren(node('option', '', 'Davr yuklanmoqda…'));
    form.elements.periodId.disabled = true;
    form.elements.amountDelta.value = '';
    form.elements.description.value = '';
    const statusButton = byId('workerStatusButton');
    statusButton.textContent = worker.status === 'ACTIVE' ? 'Ishchini nofaol qilish' : 'Ishchini faollashtirish';
    statusButton.dataset.status = worker.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    statusButton.disabled = false;
    byId('workerInactiveNote').hidden = worker.status === 'ACTIVE';
    form.querySelector('button[type="submit"]').disabled = worker.status !== 'ACTIVE';
    byId('workerDialog').showModal();
    void loadOpenPeriods(worker.companyId).catch((error) => {
      form.elements.periodId.replaceChildren(node('option', '', 'Davrlar olinmadi'));
      toast(`Ochiq davrlar olinmadi: ${error.code || 'API_UNAVAILABLE'}`);
    });
  }

  async function submitWorkerEdit(event) {
    event.preventDefault();
    if (state.workerSubmitting) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const adjustmentType = String(data.get('adjustmentType') || '');
    const amountRaw = String(data.get('amountDelta') || '').trim();
    const description = String(data.get('description') || '').trim();
    const periodId = String(data.get('periodId') || '').trim();
    if (adjustmentType && (!periodId || !amountRaw || !description)) { toast('Avans yoki jarima uchun davr, miqdor va izoh kiriting.'); return; }
    if (!adjustmentType && (periodId || amountRaw || description)) { toast('Avans/jarima maydonlari bilan amal turini ham tanlang.'); return; }
    if (adjustmentType && !window.confirm(`${adjustmentType === 'AVANS' ? 'Avans' : 'Jarima'} · ${money(amountRaw)} · ${description} · tanlangan ochiq davrga yozilsinmi?`)) return;
    const body = {
      name: String(data.get('name') || '').trim(),
      role: String(data.get('role') || '').trim() || null,
      staj: Number(data.get('staj')),
      baseRevision: Number(data.get('baseRevision')),
      operationId: crypto.randomUUID(),
      commandId: crypto.randomUUID()
    };
    if (adjustmentType) body.adjustment = { type: adjustmentType, periodId, amountDelta: Number(amountRaw), description, adjustmentId: crypto.randomUUID() };
    state.workerSubmitting = true;
    const saveButton = form.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    let saveSucceeded = false;
    try {
      await request(`${API}/companies/${encodeURIComponent(data.get('companyId'))}/workers/${encodeURIComponent(data.get('workerId'))}`, { method: 'PUT', body });
      saveSucceeded = true;
      byId('workerDialog').close();
      toast(adjustmentType ? 'Ishchi va hisob-fakti saqlandi.' : 'Ishchi ma’lumoti saqlandi.');
    } catch (error) { toast(`Ishchi saqlanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    finally {
      state.workerSubmitting = false;
      if (byId('workerDialog').open) {
        const worker = state.workers.find((item) => String(item.workerId) === String(data.get('workerId')) && item.companyId === data.get('companyId'));
        saveButton.disabled = worker?.status !== 'ACTIVE';
      }
    }
    if (saveSucceeded) {
      try { await loadWorkers(); }
      catch (error) { toast(`Ishchi saqlandi, ro‘yxat yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    }
  }

  async function changeWorkerStatus() {
    const form = byId('workerEditForm');
    const status = byId('workerStatusButton').dataset.status;
    const workerId = form.elements.workerId.value;
    const companyId = form.elements.companyId.value;
    const worker = state.workers.find((item) => String(item.workerId) === String(workerId) && item.companyId === companyId);
    if (!worker || !window.confirm(`${worker.name} (#${worker.workerId}) ishchisini ${status === 'ACTIVE' ? 'faollashtirasizmi' : 'nofaol qilasizmi'}?`)) return;
    const button = byId('workerStatusButton');
    button.disabled = true;
    let statusChanged = false;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyId)}/workers/${encodeURIComponent(workerId)}/status`, {
        method: 'PUT', body: { status, baseRevision: worker.serverRevision, operationId: crypto.randomUUID(), commandId: crypto.randomUUID() }
      });
      statusChanged = true;
      byId('workerDialog').close();
      toast(status === 'ACTIVE' ? 'Ishchi faollashtirildi.' : 'Ishchi nofaol qilindi.');
    } catch (error) { toast(`Status o‘zgarmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    finally { button.disabled = false; }
    if (statusChanged) {
      try { await loadWorkers(); }
      catch (error) { toast(`Status o‘zgartirildi, ro‘yxat yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    }
  }

  async function unbindWorker(button) {
    const { workerId, companyId, telegramId, workerName } = button.dataset;
    if (!window.confirm(`${workerName || `#${workerId}`} ishchining Telegram ID ${telegramId} bog‘lanishini bekor qilasizmi?`)) return;
    button.disabled = true;
    let unbound = false;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyId)}/workers/${encodeURIComponent(workerId)}/unbind`, {
        method: 'POST', body: { telegramId }
      });
      unbound = true;
      toast('Telegram bog‘lanishi bekor qilindi. Ishchi qayta bog‘lanishi mumkin.');
    } catch (error) { toast(`Bog‘lanish bekor qilinmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    finally { button.disabled = false; }
    if (unbound) {
      try { await Promise.all([loadWorkers(), loadBindings()]); }
      catch (error) { toast(`Bog‘lanish bekor qilindi, ro‘yxat yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    }
  }

  function openWorkerSalaryDetail(worker, companyId) {
    if (!worker) return;
    state.selectedWorkerPayroll = { ...worker, companyId };
    setText('wsdWorkerName', worker.name || 'Ishchi');
    setText('wsdWorkerRole', worker.role || 'Xodim');
    setText('wsdWorkerId', `ID ${worker.workerId}`);
    setText('wsdNetPay', number(worker.net || 0));

    const isBound = Boolean(worker.isBound || worker.boundTelegramId || worker.telegramId);
    const boundBadge = byId('wsdWorkerBoundBadge');
    if (boundBadge) {
      boundBadge.textContent = isBound ? 'Ulangan' : 'Bog‘lanmagan';
      boundBadge.className = `wsd-bound-badge ${isBound ? 'is-bound' : 'is-unbound'}`;
    }

    const statusBadge = byId('wsdPayStatusBadge');
    if (statusBadge) {
      const isPaid = Number(worker.net || 0) > 0 && !worker.avans && !worker.jarima;
      statusBadge.textContent = isPaid ? 'To‘langan' : 'Kutilmoqda';
    }

    const pieces = Number(worker.pieces || 0);
    const gross = Number(worker.gross || 0);
    setText('wsdStatPieces', `${number(pieces)} dona`);
    const days = Number(worker.days || worker.workedDays || 0);
    setText('wsdStatDays', days > 0 ? `${days} kun` : '—');
    const daily = days > 0 && gross > 0 ? Math.round(gross / days) : 0;
    setText('wsdStatDaily', daily > 0 ? `${number(daily)}` : '—');

    setText('wsdPieceWorkPay', `+${money(worker.gross || 0)}`);
    setText('wsdStajBonus', `+${money(worker.staj || 0)}`);
    setText('wsdPenalty', `-${money(worker.jarima || 0)}`);
    setText('wsdAdvance', `-${money(worker.avans || 0)}`);

    const histList = byId('wsdHistoryList');
    if (histList) {
      histList.replaceChildren();
      histList.appendChild(node('p', 'empty-state', 'Oldingi yopiq davrlar mavjud emas.'));
    }

    const dialog = byId('workerSalaryDetailDialog');
    if (dialog) dialog.showModal();
  }

  async function loadPayroll(filters) {
    if (!filters?.companyId) {
      tableMessage('payrollRows', 'payrollEmpty', []);
      setText('payrollPeriod', 'Korxona ID kiriting.');
      return;
    }
    const result = await request(withQuery(`${API}/payroll`, filters));
    const payroll = result.payroll;
    setText('payrollPeriod', payroll.period
      ? `${payroll.period.name} · ${payroll.period.startDate}${payroll.period.endDate ? ` — ${payroll.period.endDate}` : ' · ochiq'}`
      : 'Davr topilmadi; saqlangan faktlari bo‘yicha ko‘rinish.');
    const workers = payroll.workers || [];

    // Calculate Hero Banner Totals (02_ishchilar_oyliklar.png)
    const totalGross = workers.reduce((sum, w) => sum + Number(w.gross || 0), 0);
    const totalPaid = workers.reduce((sum, w) => sum + Number(w.net || 0), 0);
    const remaining = Math.max(0, totalGross - totalPaid);

    setText('payrollHeroTotal', totalGross > 0 ? number(totalGross) : '0');
    setText('payrollHeroPaid', totalPaid > 0 ? `To‘langan ${(totalPaid / 1000000).toFixed(1)} mln` : 'To‘langan 0');
    setText('payrollHeroRemaining', remaining > 0 ? `Qoldi ${(remaining / 1000000).toFixed(1)} mln` : 'Qoldi 0');

    const tbody = tableMessage('payrollRows', 'payrollEmpty', workers);
    for (const worker of workers) {
      const row = node('tr');
      cell(row, `#${worker.workerId}`, 'mono');
      cell(row, worker.name);
      cell(row, money(worker.gross));
      cell(row, money(worker.avans));
      cell(row, money(worker.jarima));
      cell(row, money(worker.staj));
      cell(row, money(worker.net));
      cell(row, number(worker.pieces));
      tbody.appendChild(row);
    }
    if (workers.length === 0) byId('payrollEmpty').textContent = 'Davr yoki ish haqi ma’lumotlari mavjud emas.';

    const payrollGrid = byId('payrollCardGrid');
    if (payrollGrid) {
      payrollGrid.replaceChildren();

      let displayWorkers = workers;
      const q = String(state.payrollSearchQuery || '').trim().toLowerCase();
      if (q) {
        displayWorkers = displayWorkers.filter((w) =>
          (w.name && w.name.toLowerCase().includes(q)) ||
          String(w.workerId).includes(q)
        );
      }

      if (!displayWorkers.length) {
        payrollGrid.appendChild(node('p', 'empty-state', 'Ish haqi faktlari topilmadi.'));
      } else {
        for (const worker of displayWorkers) {
          const card = node('article', 'worker-touch-card payroll-touch-card');
          card.onclick = () => openWorkerSalaryDetail(worker, filters.companyId);

          const top = node('div', 'worker-touch-card-top');
          const left = node('div', 'worker-card-left');
          const letter = (worker.name || 'I').trim().charAt(0).toUpperCase();
          const av = node('div', 'sys-co-avatar sys-avatar-t', letter);
          left.appendChild(av);

          const nameWrap = node('div', 'worker-name-block');
          nameWrap.appendChild(node('strong', 'worker-touch-title', worker.name));
          nameWrap.appendChild(node('span', 'worker-role-sub', `${number(worker.pieces)} dona · ID ${worker.workerId}`));
          left.appendChild(nameWrap);
          top.appendChild(left);

          const rightWrap = node('div', 'worker-card-right');
          rightWrap.appendChild(node('strong', 'payroll-amount-text', `${number(worker.net)} so‘m`));
          const isPaid = Number(worker.net || 0) > 0 && !worker.avans && !worker.jarima;
          const statusBadge = node('span', `sys-pill-tag ${isPaid ? 'sys-pill-green' : 'sys-pill-orange'}`, isPaid ? 'To‘langan' : 'Kutilmoqda');
          rightWrap.appendChild(statusBadge);
          top.appendChild(rightWrap);

          card.appendChild(top);
          payrollGrid.appendChild(card);
        }
      }
    }
  }

  function syncActivationControls() {
    const selected = selectedActivation();
    const approveBtn = byId('approveActivation');
    const rejectBtn = byId('rejectActivation');
    const revokeBtn = byId('revokeActivation');
    const companySelect = byId('activationCompanySelect');
    const roleSelect = byId('activationForm')?.elements?.role;

    if (!selected) {
      if (approveBtn) approveBtn.disabled = true;
      if (rejectBtn) rejectBtn.disabled = true;
      if (revokeBtn) revokeBtn.disabled = true;
      return;
    }

    if (approveBtn) approveBtn.disabled = selected.status !== 'PENDING';
    if (rejectBtn) rejectBtn.disabled = selected.status !== 'PENDING';
    if (revokeBtn) revokeBtn.disabled = selected.status !== 'APPROVED';

    if (selected.companyId && companySelect) {
      if ([...companySelect.options].some((opt) => opt.value === selected.companyId)) {
        companySelect.value = selected.companyId;
      }
    }
    if (selected.role && roleSelect) {
      roleSelect.value = selected.role;
    }
  }

  async function loadActivations() {
    if (state.companies.length === 0) await loadCompanies();
    const status = byId('activationStatusFilter').value;
    const result = await request(withQuery(`${API}/activations`, { status, limit: 100 }));
    state.activations = result.activations || [];
    const pendingRequests = state.activations.filter((item) => item.status === 'PENDING');
    const requestSelect = byId('activationRequestSelect');
    const oldRequest = requestSelect.value;
    requestSelect.replaceChildren(node('option', '', 'So‘rovni tanlang'));
    for (const item of state.activations) {
      const option = node('option', '', `${item.machineId} · ${statusLabel(item.status)} · ${String(item.requestId).slice(0, 8)}`);
      option.value = item.requestId;
      option.dataset.status = item.status;
      requestSelect.appendChild(option);
    }
    if (oldRequest && [...requestSelect.options].some((option) => option.value === oldRequest)) {
      requestSelect.value = oldRequest;
    } else if (pendingRequests.length > 0) {
      requestSelect.value = pendingRequests[0].requestId;
    } else if (state.activations.length > 0) {
      requestSelect.value = state.activations[0].requestId;
    }
    refreshCompanySelectors();
    syncActivationControls();
    updatePendingNavBadge(pendingRequests.length);

    const tbody = tableMessage('activationRows', 'activationEmpty', state.activations);
    for (const item of state.activations) {
      const row = node('tr');
      cell(row, item.machineId, 'mono');
      const statusTd = node('td'); statusTd.appendChild(statusBadge(item.status)); row.appendChild(statusTd);
      cell(row, item.companyName || item.companyId || '—');
      cell(row, item.role || '—');
      cell(row, timestamp(item.requestedAt));
      const actionCell = node('td');
      actionCell.className = 'actions-cell';
      actionCell.appendChild(node('span', item.signedActivation ? 'signature-state is-signed' : 'signature-state', item.signedActivation ? 'Tasdiqlangan' : '—'));
      const selectBtn = node('button', item.status === 'PENDING' ? 'small-action button-accent-action' : 'small-action', item.status === 'PENDING' ? '⚡ Boshqarish' : 'Tanlash');
      selectBtn.type = 'button';
      selectBtn.dataset.selectRequest = item.requestId;
      actionCell.appendChild(selectBtn);
      const events = node('button', 'small-action', 'Audit');
      events.type = 'button';
      events.dataset.eventsRequest = item.requestId;
      actionCell.appendChild(events);
      row.appendChild(actionCell);
      tbody.appendChild(row);
    }

    const actGrid = byId('activationCardGrid');
    if (actGrid) {
      actGrid.replaceChildren();
      if (!state.activations.length) {
        actGrid.appendChild(node('p', 'empty-state', 'Aktivatsiya so‘rovlari mavjud emas.'));
      } else {
        for (const item of state.activations) {
          const card = node('article', `activation-touch-card ${item.status === 'PENDING' ? 'is-pending-card' : ''}`);
          const top = node('div', 'party-touch-card-top');
          const idWrap = node('div');
          idWrap.appendChild(node('strong', 'mono', item.machineId));
          idWrap.appendChild(node('span', 'mono muted', ` (${String(item.requestId).slice(0, 8)})`));
          top.appendChild(idWrap);
          top.appendChild(statusBadge(item.status));
          card.appendChild(top);

          const meta = node('div', 'worker-touch-stats');
          meta.appendChild(node('span', '', item.companyName || item.companyId || 'Korxona belgilanmagan'));
          meta.appendChild(node('span', '', `Rol: ${item.role || 'Admin'}`));
          card.appendChild(meta);
          card.appendChild(node('time', 'mono muted', `So‘rov vaqti: ${timestamp(item.requestedAt)}`));

          if (item.status === 'PENDING') {
            const actions = node('div', 'worker-touch-actions');
            const approveBtn = node('button', 'button button-primary button-sm', '✅ Tasdiqlash');
            approveBtn.type = 'button';
            approveBtn.onclick = async () => {
              byId('activationRequestSelect').value = item.requestId;
              syncActivationControls();
              if (item.companyId) {
                byId('activationCompanySelect').value = item.companyId;
              }
              await submitActivationAction('approve');
            };
            actions.appendChild(approveBtn);

            const rejectBtn = node('button', 'button button-danger button-sm', '❌ Rad etish');
            rejectBtn.type = 'button';
            rejectBtn.onclick = async () => {
              byId('activationRequestSelect').value = item.requestId;
              syncActivationControls();
              const reason = window.prompt('Rad etish sababini kiriting:');
              if (!reason) return;
              byId('activationForm').elements.reason.value = reason;
              await submitActivationAction('reject');
            };
            actions.appendChild(rejectBtn);

            card.appendChild(actions);
          }
          actGrid.appendChild(card);
        }
      }
    }
    if (!state.access?.isGlobalAdmin) {
      const coId = state.access?.companyIds?.[0];
      const co = (state.companies || []).find((c) => c.companyId === coId);
      const actNameInput = byId('actPolicyMobileName');
      if (actNameInput && !actNameInput.value && co?.companyName) {
        actNameInput.value = co.companyName;
      }
    }
    renderExpiringLicenses();
  }

  function renderExpiringLicenses() {
    const feed = byId('expiringLicensesFeed');
    const badge = byId('expiringCountBadge');
    if (!feed) return;
    feed.replaceChildren();

    const expiring = [];
    const now = Date.now();
    for (const act of (state.activations || [])) {
      if (act.status === 'APPROVED' && act.signedActivation) {
        const reqTime = new Date(act.requestedAt).getTime();
        const diffDays = Math.max(1, Math.round((now - reqTime) / (1000 * 60 * 60 * 24)));
        expiring.push({
          name: act.companyName || act.companyId || act.machineId,
          sub: `${diffDays} kun oldin tasdiqlangan`,
          tag: 'Faol',
          urgent: false
        });
      }
    }

    if (badge) badge.textContent = String(expiring.length);

    if (!expiring.length) {
      feed.appendChild(node('p', 'empty-state', 'Muddati tugayotgan litsenziyalar yo‘q.'));
      return;
    }

    for (const item of expiring.slice(0, 5)) {
      const alertItem = node('div', 'sys-alert-item');
      const letter = (item.name || 'K').trim().charAt(0).toUpperCase();
      const av = node('div', 'sys-co-avatar sys-avatar-t', letter);
      alertItem.appendChild(av);

      const body = node('div', 'sys-alert-body');
      body.appendChild(node('strong', 'sys-alert-title', item.name));
      body.appendChild(node('span', 'sys-alert-sub', item.sub));
      alertItem.appendChild(body);

      const tag = node('span', `sys-pill-tag ${item.urgent ? 'sys-pill-red' : 'sys-pill-orange'}`, item.tag);
      alertItem.appendChild(tag);
      feed.appendChild(alertItem);
    }
  }

  async function showActivationEvents(requestId) {
    const panel = byId('activationEvents');
    panel.replaceChildren();
    const heading = node('h3', '', `So‘rov ${String(requestId).slice(0, 8)} · audit voqealari`);
    panel.appendChild(heading);
    const result = await request(`${API}/activations/${encodeURIComponent(requestId)}/events`);
    const events = result.events || [];
    if (!events.length) panel.appendChild(node('p', 'empty-state', 'Audit voqealari mavjud emas.'));
    for (const event of events) {
      const row = node('div', 'event-item');
      row.appendChild(node('strong', '', `${event.eventType} · ${event.actorTelegramId}`));
      row.appendChild(node('time', '', timestamp(event.createdAt)));
      panel.appendChild(row);
    }
    panel.hidden = false;
  }

  async function loadAdminView() {
    setText('sessionTelegramId', state.user?.id || '—');
    setText('sessionName', [state.user?.firstName, state.user?.lastName].filter(Boolean).join(' ') || state.user?.username || 'Admin');
    setText('sessionExpires', timestamp(state.expiresAt * 1000));
  }

  async function loadModels() {
    const result = await request(`${API}/models`);
    const rows = result.models || [];
    setText('modelsCountBadge', number(rows.length));
    const body = tableMessage('modelRows', 'modelEmpty', rows, 'Model yozuvlari topilmadi.');
    for (const item of rows) {
      const row = node('tr');
      cell(row, item.companyId, 'mono'); cell(row, item.modelId, 'mono'); cell(row, item.name);
      cell(row, (item.operations || []).map((operation) => `${operation.name || '—'}: ${operation.rate ?? '—'}`).join(', ') || '—');
      cell(row, (item.availableSizes || []).join(', ') || '—'); cell(row, item.serverRevision ?? '—'); body.appendChild(row);
    }
    const grid = byId('modelCardGrid');
    if (grid) {
      grid.replaceChildren();
      let displayModels = rows;
      const q = String(state.modelSearchQuery || '').trim().toLowerCase();
      if (q) {
        displayModels = displayModels.filter((m) =>
          (m.name && m.name.toLowerCase().includes(q)) ||
          String(m.modelId).toLowerCase().includes(q) ||
          (m.companyId && m.companyId.toLowerCase().includes(q))
        );
      }
      if (!displayModels.length) grid.appendChild(node('p', 'empty-state', 'Model yozuvlari topilmadi.'));
      else {
        for (const item of displayModels) {
          const card = node('article', 'model-touch-card');
          const top = node('div', 'party-touch-card-top');
          const leftWrap = node('div', 'model-meta-left');
          leftWrap.appendChild(node('strong', 'party-touch-title', item.name));
          if (item.companyId && state.access?.isGlobalAdmin) {
            leftWrap.appendChild(node('span', 'mono muted model-id-sub', item.companyId));
          }
          top.appendChild(leftWrap);

          const rateSum = (item.operations || []).reduce((s, op) => s + Number(op.rate || 0), 0);
          top.appendChild(node('span', 'sys-pill-tag sys-pill-green', `● ${number(rateSum)} so‘m`));
          card.appendChild(top);

          const ops = item.operations || [];
          const meta = node('div', 'worker-touch-stats');
          meta.appendChild(node('span', '', `Ratsenka summasi: ${number(rateSum)} so‘m`));
          meta.appendChild(node('span', 'mono muted', `Amallar: ${ops.length} ta`));
          card.appendChild(meta);

          if (item.availableSizes && item.availableSizes.length > 0) {
            card.appendChild(node('div', 'count-label', `O‘lchamlar: ${item.availableSizes.join(', ')}`));
          }
          grid.appendChild(card);
        }
      }
    }
  }

  async function loadParties() {
    const result = await request(`${API}/parties`);
    const rows = result.parties || [];
    setText('partiesCountBadge', number(rows.length));
    const body = tableMessage('partyRows', 'partyEmpty', rows, 'Partiya yozuvlari topilmadi.');
    for (const item of rows) {
      const row = node('tr'); cell(row, item.partyRecordId, 'mono'); cell(row, item.partyNumber);
      cell(row, item.companyId, 'mono'); cell(row, `${item.modelName || '—'} · ${item.modelId || ''}`);
      const status = node('td'); status.appendChild(statusBadge(item.status)); row.appendChild(status);
      cell(row, number(item.pattaCount)); cell(row, number(item.ishSoni)); cell(row, timestamp(item.updatedAt)); body.appendChild(row);
    }
    const grid = byId('partyCardGrid');
    if (grid) {
      grid.replaceChildren();
      let displayParties = rows;
      if (state.partyFilter === 'active') {
        displayParties = displayParties.filter((p) => p.status === 'ACTIVE');
      } else if (state.partyFilter === 'closed') {
        displayParties = displayParties.filter((p) => p.status === 'CLOSED');
      }
      const q = String(state.partySearchQuery || '').trim().toLowerCase();
      if (q) {
        displayParties = displayParties.filter((p) =>
          String(p.partyNumber).toLowerCase().includes(q) ||
          (p.modelName && p.modelName.toLowerCase().includes(q)) ||
          String(p.modelId || '').toLowerCase().includes(q) ||
          (p.companyId && p.companyId.toLowerCase().includes(q))
        );
      }
      if (!displayParties.length) grid.appendChild(node('p', 'empty-state', 'Partiya yozuvlari topilmadi.'));
      else {
        for (const item of displayParties) {
          const card = node('article', 'party-touch-card');
          const top = node('div', 'party-touch-card-top');
          const leftWrap = node('div', 'party-title-wrap');
          leftWrap.appendChild(node('strong', 'party-touch-title', `Partiya № ${item.partyNumber}`));
          leftWrap.appendChild(node('span', 'party-model-sub', `${item.modelName || item.modelId || 'Model'}${item.companyId ? ` · ${item.companyId}` : ''}`));
          top.appendChild(leftWrap);
          top.appendChild(statusBadge(item.status));
          card.appendChild(top);

          const total = Number(item.pattaCount || 0);
          const sewn = Number(item.ishSoni || 0);
          const pct = total > 0 ? Math.min(100, Math.round((sewn / total) * 100)) : 0;

          const stats = node('div', 'worker-touch-stats');
          stats.appendChild(node('span', '', `Tikilgan: ${number(sewn)} / ${number(total)} dona`));
          stats.appendChild(node('span', 'mono', `${pct}% bajarildi`));
          card.appendChild(stats);

          const bar = node('div', 'batch-progress-bar');
          const fill = node('div', 'batch-progress-fill');
          fill.style.width = `${pct}%`;
          bar.appendChild(fill);
          card.appendChild(bar);

          const footer = node('div', 'device-time-row');
          footer.appendChild(node('time', 'mono muted', `Yangilangan: ${timestamp(item.updatedAt)}`));
          card.appendChild(footer);

          grid.appendChild(card);
        }
      }
    }
  }

  async function loadTickets() {
    const result = await request(`${API}/tickets`);
    const rows = result.tickets || [];
    const body = tableMessage('ticketRows', 'ticketEmpty', rows, 'Hali ticket qayd etilmagan.');
    for (const item of rows) {
      const row = node('tr'); cell(row, item.ticketId, 'mono');
      cell(row, item.workerId == null ? '—' : `#${item.workerId} ${item.workerName || ''}`);
      cell(row, `${item.partyNumber || '—'} · ${item.partyRecordId || ''}`);
      cell(row, item.modelName || item.modelId); cell(row, item.operation || '—'); cell(row, number(item.quantity));
      const status = node('td'); status.appendChild(statusBadge(item.status)); row.appendChild(status);
      cell(row, timestamp(item.effectiveAt)); body.appendChild(row);
    }
    const grid = byId('ticketCardGrid');
    if (grid) {
      grid.replaceChildren();
      if (!rows.length) grid.appendChild(node('p', 'empty-state', 'Hali ticket qayd etilmagan.'));
      else {
        for (const item of rows) {
          const card = node('article', 'ticket-touch-card');
          const top = node('div', 'worker-touch-card-top');
          top.appendChild(node('strong', '', item.workerName ? `${item.workerName} (#${item.workerId})` : `#${item.workerId || '—'}`));
          top.appendChild(statusBadge(item.status));
          card.appendChild(top);
          card.appendChild(node('div', 'count-label', `${item.modelName || item.modelId || '—'} · ${item.operation || 'Amal'} · ${number(item.quantity)} dona`));
          card.appendChild(node('time', 'mono muted', timestamp(item.effectiveAt)));
          grid.appendChild(card);
        }
      }
    }
  }

  async function loadBalances() {
    const select = byId('balanceCompanySelect');
    const companyId = select?.value || state.companies.find((item) => item.businessScopeExists)?.companyId;
    if (!companyId) {
      tableMessage('balanceRows', 'balanceEmpty', [], 'Mavjud biznes scope topilmadi.');
      byId('balanceWorkerSelect').replaceChildren(node('option', '', 'Avval kompaniyani tanlang'));
      byId('balanceWorkerSelect').disabled = true;
      byId('balancePeriodSelect').replaceChildren(node('option', '', 'Davr mavjud emas'));
      byId('balancePeriodSelect').disabled = true;
      byId('balanceViewPeriodSelect').replaceChildren(node('option', '', 'Ochiq davr mavjud emas'));
      byId('balanceViewPeriodSelect').disabled = true;
      setText('balancePeriodCaption', 'Davr tanlanmagan');
      return;
    }
    if (select && select.value !== companyId) {
      select.value = companyId;
    }
    await loadBalancePeriods();
    const periodId = byId('balanceViewPeriodSelect').value;
    const result = await request(withQuery(`${API}/balances`, { companyId, periodId }));
    setText('balancePeriodCaption', result.period
      ? `${result.period.name} · ${result.period.startDate}${result.period.endDate ? ` — ${result.period.endDate}` : ' · ochiq'}${result.period.isClosed ? ' · yopilgan' : ''}`
      : 'Ochiq davr topilmadi. Yangi davr ochilgach avans va jarimalar shu yerda ko‘rinadi.');
    const rows = result.facts || [];
    const body = tableMessage('balanceRows', 'balanceEmpty', rows, 'Balans faktlari topilmadi.');
    for (const item of rows) {
      const row = node('tr'); cell(row, `#${item.workerId}`); cell(row, item.workerName);
      cell(row, item.type === 'AVANS' ? 'Avans' : 'Jarima'); cell(row, money(item.total));
      cell(row, number(item.factCount)); cell(row, number(item.openingFactCount)); body.appendChild(row);
    }
    if (rows.length === 0) byId('balanceEmpty').textContent = 'Tanlangan davrda avans yoki jarima fakti yo‘q.';
    await loadBalanceWorkers();

    const grid = byId('balanceCardGrid');
    if (grid) {
      grid.replaceChildren();
      if (!rows.length) grid.appendChild(node('p', 'empty-state', 'Balans faktlari topilmadi.'));
      else {
        for (const item of rows) {
          const card = node('article', 'worker-touch-card');
          const top = node('div', 'worker-touch-card-top');
          top.appendChild(node('strong', 'worker-touch-title', `${item.workerName} (#${item.workerId})`));
          top.appendChild(node('span', item.type === 'AVANS' ? 'pill-avans' : 'pill-jarima', item.type === 'AVANS' ? '💵 Avans' : '⚠️ Jarima'));
          card.appendChild(top);

          const stats = node('div', 'worker-touch-stats');
          stats.appendChild(node('strong', 'stat-num', money(item.total)));
          stats.appendChild(node('span', '', `${number(item.factCount)} ta yozuv`));
          card.appendChild(stats);

          const actions = node('div', 'worker-touch-actions');
          const adjBtn = node('button', 'button button-primary button-sm', '💵 + Avans berish');
          adjBtn.type = 'button';
          adjBtn.dataset.quickAdj = String(item.workerId);
          adjBtn.dataset.companyId = companyId;
          adjBtn.dataset.workerName = item.workerName;
          actions.appendChild(adjBtn);
          card.appendChild(actions);

          grid.appendChild(card);
        }
      }
    }
  }

  async function loadBalanceWorkers(search = state.balanceWorkerSearch) {
    const companyId = byId('balanceCompanySelect').value;
    const select = byId('balanceWorkerSelect');
    state.balanceWorkerSearch = String(search || '').trim().slice(0, 100);
    if (!companyId) return;
    select.disabled = true;
    const result = await request(withQuery(`${API}/workers`, {
      companyId, search: state.balanceWorkerSearch, limit: 100, offset: 0
    }));
    const workers = (result.workers || []).filter((worker) => worker.status === 'ACTIVE');
    const previousValue = select.value;
    select.replaceChildren(node('option', '', workers.length ? 'Ishchini tanlang' : 'Faol ishchi topilmadi'));
    for (const worker of workers) {
      const option = node('option', '', `#${worker.workerId} · ${worker.name}`);
      option.value = String(worker.workerId);
      option.dataset.serverRevision = String(worker.serverRevision ?? 0);
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === previousValue)) select.value = previousValue;
    select.disabled = workers.length === 0;
  }

  async function loadBalancePeriods() {
    const companyId = byId('balanceCompanySelect').value;
    const editSelect = byId('balancePeriodSelect');
    const viewSelect = byId('balanceViewPeriodSelect');
    if (!companyId) return;
    editSelect.disabled = true;
    viewSelect.disabled = true;
    const result = await request(`${API}/companies/${encodeURIComponent(companyId)}/periods`);
    const periods = result.periods || [];
    const openPeriods = periods.filter((period) => !period.isClosed);
    const previousViewValue = viewSelect.value;
    viewSelect.replaceChildren(node('option', '', 'Joriy ochiq davr'));
    for (const period of periods) {
      const option = node('option', '', `${period.name} · ${period.startDate}${period.endDate ? ` — ${period.endDate}` : ''}${period.isClosed ? ' · yopilgan' : ''}`);
      option.value = period.periodId;
      viewSelect.appendChild(option);
    }
    if (previousViewValue && [...viewSelect.options].some((option) => option.value === previousViewValue)) viewSelect.value = previousViewValue;
    else viewSelect.value = openPeriods[0]?.periodId || '';
    viewSelect.disabled = periods.length === 0;

    const previousEditValue = editSelect.value;
    editSelect.replaceChildren(node('option', '', openPeriods.length ? 'Ochiq davrni tanlang' : 'Ochiq davr mavjud emas'));
    for (const period of openPeriods) {
      const option = node('option', '', `${period.name} · ${period.startDate}`);
      option.value = period.periodId;
      editSelect.appendChild(option);
    }
    if (previousEditValue && [...editSelect.options].some((option) => option.value === previousEditValue)) editSelect.value = previousEditValue;
    else editSelect.value = openPeriods[0]?.periodId || '';
    editSelect.disabled = openPeriods.length === 0;
  }

  async function submitBalanceAdjustment(event) {
    event.preventDefault();
    if (state.balanceSubmitting) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const companyId = byId('balanceCompanySelect').value;
    const workerSelect = byId('balanceWorkerSelect');
    const selectedWorker = workerSelect.selectedOptions[0];
    const workerId = String(data.get('workerId') || '').trim();
    const periodId = String(data.get('periodId') || '').trim();
    const type = String(data.get('type') || '').trim().toUpperCase();
    const amountDelta = Number(data.get('amountDelta'));
    const description = String(data.get('description') || '').trim();
    const baseRevision = Number(selectedWorker?.dataset.serverRevision);
    if (!companyId || !workerId || !periodId || !['AVANS', 'JARIMA'].includes(type)
      || !Number.isFinite(amountDelta) || amountDelta <= 0 || !description
      || !Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      toast('Kompaniya, ishchi, ochiq davr, musbat miqdor va izohni tekshiring.');
      return;
    }
    if (!window.confirm(`${type === 'AVANS' ? 'Avans' : 'Jarima'} · ${money(amountDelta)} · #${workerId} · tanlangan ochiq davrga yozilsinmi?`)) return;

    const submitButton = byId('submitBalanceAdjustment');
    submitButton.disabled = true;
    state.balanceSubmitting = true;
    let saved = false;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyId)}/workers/${encodeURIComponent(workerId)}`, {
        method: 'PUT',
        body: {
          baseRevision,
          operationId: crypto.randomUUID(),
          commandId: crypto.randomUUID(),
          adjustment: { adjustmentId: crypto.randomUUID(), type, periodId, amountDelta, description }
        }
      });
      saved = true;
      form.elements.amountDelta.value = '';
      form.elements.description.value = '';
      byId('balanceViewPeriodSelect').value = periodId;
      toast(`${type === 'AVANS' ? 'Avans' : 'Jarima'} saqlandi; ulangan desktopga sync qilinadi.`);
    } catch (error) {
      toast(`Yozuv saqlanmadi: ${error.code || 'API_UNAVAILABLE'}`);
    } finally {
      state.balanceSubmitting = false;
      submitButton.disabled = false;
    }
    if (saved) {
      try { await loadBalances(); }
      catch (error) { toast(`Yozuv saqlandi, jadval yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    }
  }

  async function loadSystem() {
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const { system } = await request(`${API}/system`);
    const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const latencyMs = Math.max(1, Math.round(end - start));

    setText('systemApi', system.api);
    setText('systemDatabase', system.database);
    setText('systemMigration', system.migrationLevel ?? '—');
    setText('systemRevision', system.serverRevision ?? '—');
    setText('systemChecked', timestamp(system.checkedAt));
    setText('systemExternal', 'Bot va backup holati API’da yo‘q');

    // Live Latency & Status Badges
    setText('sysApiLatencyBadge', `${latencyMs} ms`);
    const apiBadge = byId('sysApiLatencyBadge');
    if (apiBadge) {
      apiBadge.className = latencyMs < 300 ? 'sys-status-badge-pill sys-badge-green' : 'sys-status-badge-pill sys-badge-orange';
    }
    setChipDot('sysApiDot', latencyMs < 500 ? 'green' : 'amber');
    setChipDot('sysChipApiDot', latencyMs < 500 ? 'green' : 'amber');

    const isPgOk = String(system.database || '').toLowerCase() === 'available' || String(system.database || '').toUpperCase() === 'READY';
    setText('sysPgLatencyBadge', isPgOk ? 'Tayyor' : (system.database || 'Ulanmagan'));
    const pgBadge = byId('sysPgLatencyBadge');
    if (pgBadge) {
      pgBadge.className = isPgOk ? 'sys-status-badge-pill sys-badge-green' : 'sys-status-badge-pill sys-badge-orange';
    }
    setChipDot('sysPgDot', isPgOk ? 'green' : 'red');
    setChipDot('sysChipPgDot', isPgOk ? 'green' : 'red');

    const isBotActive = Boolean(telegram && (telegram.initData || telegram.version));
    setText('sysBotStatusBadge', isBotActive ? 'Faol (Telegram)' : 'Noma’lum');
    const botBadge = byId('sysBotStatusBadge');
    if (botBadge) {
      botBadge.className = isBotActive ? 'sys-status-badge-pill sys-badge-green' : 'sys-status-badge-pill sys-badge-orange';
    }
    setChipDot('sysBotDot', isBotActive ? 'green' : 'amber');
    setChipDot('sysChipBotDot', isBotActive ? 'green' : 'amber');

    // Sync Delay
    let syncDelayText = 'O‘z vaqtida';
    let isDelayOk = true;
    if (system.checkedAt) {
      const checkedTime = new Date(system.checkedAt).getTime();
      const diffMinutes = Math.max(0, Math.round((Date.now() - checkedTime) / (1000 * 60)));
      if (diffMinutes > 120) {
        syncDelayText = `${Math.round(diffMinutes / 60)} soat kechikish`;
        isDelayOk = false;
      } else if (diffMinutes > 15) {
        syncDelayText = `${diffMinutes} daq. kechikish`;
        isDelayOk = false;
      }
    }
    setText('sysSyncDelayBadge', syncDelayText);
    const syncBadge = byId('sysSyncDelayBadge');
    if (syncBadge) {
      syncBadge.className = isDelayOk ? 'sys-status-badge-pill sys-badge-green' : 'sys-status-badge-pill sys-badge-orange';
    }
    setChipDot('sysSyncDot', isDelayOk ? 'green' : 'amber');
    setChipDot('sysChipSyncDot', isDelayOk ? 'green' : 'amber');

    // Telemetry Indicators (Real browser resources when supported, otherwise clean empty state)
    if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize && performance.memory.jsHeapSizeLimit) {
      const ramPct = Math.min(99, Math.max(1, Math.round((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100)));
      const ramMb = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
      setText('ramUsageVal', `${ramMb} MB (${ramPct}%)`);
      const ramFill = byId('ramProgressFill');
      if (ramFill) ramFill.style.width = `${ramPct}%`;
    } else {
      setText('ramUsageVal', '—');
      const ramFill = byId('ramProgressFill');
      if (ramFill) ramFill.style.width = '0%';
    }

    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        if (est.quota && est.usage) {
          const diskPct = Math.min(99, Math.max(1, Math.round((est.usage / est.quota) * 100)));
          const diskMb = Math.round(est.usage / (1024 * 1024));
          setText('diskUsageVal', `${diskMb} MB (${diskPct}%)`);
          const diskFill = byId('diskProgressFill');
          if (diskFill) diskFill.style.width = `${diskPct}%`;
        } else {
          setText('diskUsageVal', '—');
          const diskFill = byId('diskProgressFill');
          if (diskFill) diskFill.style.width = '0%';
        }
      } catch {
        setText('diskUsageVal', '—');
        const diskFill = byId('diskProgressFill');
        if (diskFill) diskFill.style.width = '0%';
      }
    } else {
      setText('diskUsageVal', '—');
      const diskFill = byId('diskProgressFill');
      if (diskFill) diskFill.style.width = '0%';
    }

    // CPU percentage is host-internal and not exposed via web standards without an OS agent
    setText('cpuUsageVal', '—');
    const cpuFill = byId('cpuProgressFill');
    if (cpuFill) cpuFill.style.width = '0%';

    // Dynamic Recent Events
    renderSysRecentEvents(system);
  }

  function renderSysRecentEvents(system) {
    const feed = byId('sysRecentEventsFeed');
    if (!feed) return;
    feed.replaceChildren();

    const events = [];
    if (system.checkedAt) {
      events.push({
        type: 'blue',
        title: 'Tizim salomatligi tekshirildi',
        time: timestamp(system.checkedAt).slice(-5)
      });
    }
    if (state.activations && state.activations.length) {
      const latestAct = state.activations[0];
      events.push({
        type: latestAct.status === 'APPROVED' ? 'green' : 'red',
        title: latestAct.status === 'APPROVED' ? `Aktivatsiya tasdiqlandi (#${String(latestAct.requestId).slice(0, 6)})` : `Yangi so‘rov kelib tushdi (#${String(latestAct.requestId).slice(0, 6)})`,
        time: timestamp(latestAct.requestedAt).slice(-5)
      });
    }
    if (state.companies && state.companies.length) {
      events.push({
        type: 'green',
        title: `${state.companies[0].companyName || state.companies[0].companyId} yangilandi`,
        time: state.summary?.recentSyncAt ? timestamp(state.summary.recentSyncAt).slice(-5) : 'Bugun'
      });
    }

    if (!events.length) {
      feed.appendChild(node('p', 'empty-state', 'Oxirgi xatolik yoki hodisalar qayd etilmagan.'));
      return;
    }

    for (const ev of events) {
      const item = node('div', 'sys-event-item');
      const iconWrap = node('div', `sys-alert-icon sys-alert-icon-${ev.type}`);
      iconWrap.appendChild(svgIcon('M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83', 18));
      item.appendChild(iconWrap);

      const body = node('div', 'sys-alert-body');
      body.appendChild(node('strong', 'sys-alert-title', ev.title));
      item.appendChild(body);

      const time = node('time', 'sys-event-time', ev.time);
      item.appendChild(time);
      feed.appendChild(item);
    }
  }

  const loaders = {
    overview: loadOverview,
    devices: loadDevices,
    companies: loadCompanies,
    'company-profile': () => loadCompanyProfile(state.selectedCompanyId),
    workers: () => loadWorkers(state.workerFilters),
    bindings: loadBindings,
    activations: loadActivations,
    admin: loadAdminView,
    models: loadModels, parties: loadParties, tickets: loadTickets,
    balances: async () => { if (!state.companies.length) await loadCompanies(); await loadBalances(); },
    system: loadSystem,
    more: async () => { }
  };

  async function loadCurrentView() {
    const loader = loaders[state.currentView];
    if (!loader) return;
    setNotice('Ma’lumot yuklanmoqda…', 'loading');
    try {
      await loader();
      setNotice('');
      setText('lastUpdated', `Yangilandi ${timestamp(new Date().toISOString())}`);
    } catch (error) {
      if (error.code === 'ADMIN_SESSION_REJECTED') return;
      setNotice(`Ma’lumot olinmadi: ${error.code || 'API_UNAVAILABLE'}. Tizim holatini tekshirib, qayta urinib ko‘ring.`, 'error');
    }
  }

  function handleNavigateBack() {
    const quickDialog = byId('quickAdjustmentDialog');
    if (quickDialog && quickDialog.open) {
      quickDialog.close();
      return;
    }
    const dialog = byId('workerDialog');
    if (dialog && dialog.open) {
      dialog.close();
      return;
    }
    try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
    if (state.currentView === 'overview' && state.selectedCompanyId && state.access?.isGlobalAdmin) {
      state.selectedCompanyId = null;
      showView('companies');
      return;
    }
    if (state.currentView === 'company-profile') {
      showView(state.previousView === 'overview' ? 'overview' : 'companies');
      return;
    }
    const fromMoreViews = ['devices', 'system', 'models', 'parties'];
    if (fromMoreViews.includes(state.currentView)) {
      showView('more');
    } else {
      showView('overview');
    }
  }

  function applyRoleNavigation() {
    const isGlobal = Boolean(state.access?.isGlobalAdmin);
    const factoryViews = ['workers', 'models', 'parties'];
    const platformViews = ['companies', 'system'];

    for (const button of document.querySelectorAll('#mainNav .nav-button[data-view]')) {
      const v = button.dataset.view;
      if (isGlobal) {
        // System admin manages platform directory; factory operations are strictly scoped inside Company Profile
        button.hidden = factoryViews.includes(v);
      } else {
        // Factory director oversees their factory; platform administration views are hidden
        button.hidden = platformViews.includes(v) || (!state.access.isGlobalAdmin && button.dataset.view === 'system');
      }
    }

    // Role-specific Mobile Tab Labels & Yana screen
    if (isGlobal) {
      setText('breadcrumbBadge', 'TIZIM BOSHQARUVI');
      setText('navActivationsMobileLabel', 'Litsenziya');
      setText('activationsTitle', 'Litsenziya');
      const actTabPolicy = byId('actTabPolicyBtn');
      if (actTabPolicy) actTabPolicy.textContent = 'Litsenziyalar';
      byId('moreMenuListSystem')?.removeAttribute('hidden');
      byId('moreMenuListCompany')?.setAttribute('hidden', '');
      const profileCard = byId('moreProfileCard');
      if (profileCard) {
        profileCard.className = 'more-profile-card more-profile-system';
      }
      setText('mobileBrandName', 'Novo System');
      setText('mobileBrandInitial', 'N');
      const userName = [state.user?.firstName, state.user?.lastName].filter(Boolean).join(' ') || state.user?.username || 'Tizim administratori';
      setText('moreAdminName', userName);
      setText('moreAdminRole', 'Tizim administratori');
      setText('moreAvatar', (userName || 'S').charAt(0).toUpperCase());
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      setText('moreAdminMeta', state.summary?.recentSyncAt
        ? `Oxirgi sinxron: ${formatRelativeTime(state.summary.recentSyncAt)}`
        : `Kirish: ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} · ${pad(now.getHours())}:${pad(now.getMinutes())}`);
    } else {
      setText('breadcrumbBadge', 'KORXONA BOSHQARUVI');
      setText('navActivationsMobileLabel', 'Aktivatsiya');
      setText('activationsTitle', 'Aktivatsiya');
      const actTabPolicy = byId('actTabPolicyBtn');
      if (actTabPolicy) actTabPolicy.textContent = 'Siyosat';
      byId('moreMenuListSystem')?.setAttribute('hidden', '');
      byId('moreMenuListCompany')?.removeAttribute('hidden');
      const profileCard = byId('moreProfileCard');
      if (profileCard) {
        profileCard.className = 'more-profile-card more-profile-company';
      }
      const coId = state.access?.companyIds?.[0];
      const co = (state.companies || []).find((c) => c.companyId === coId);
      const coName = co?.companyName || (coId ? `Korxona (${coId})` : 'Korxona');
      setText('mobileBrandName', coName);
      setText('mobileBrandInitial', coName.charAt(0).toUpperCase());
      const userName = [state.user?.firstName, state.user?.lastName].filter(Boolean).join(' ') || state.user?.username || `Admin · ${coName}`;
      setText('moreAdminName', userName);
      setText('moreAdminRole', `Korxona administratori · ${coName}`);
      setText('moreAvatar', (userName || coName).charAt(0).toUpperCase());
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      setText('moreAdminMeta', state.summary?.recentSyncAt
        ? `Oxirgi sinxron: ${formatRelativeTime(state.summary.recentSyncAt)}`
        : `Kirish: ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} · ${pad(now.getHours())}:${pad(now.getMinutes())}`);
      const actNameInput = byId('actPolicyMobileName');
      if (actNameInput && !actNameInput.value && co?.companyName) {
        actNameInput.value = co.companyName;
      }
    }

    // Quick-grid items in #more section
    for (const card of document.querySelectorAll('.quick-grid [data-go]')) {
      const go = card.dataset.go;
      if (isGlobal) {
        card.hidden = factoryViews.includes(go);
      } else {
        card.hidden = platformViews.includes(go);
      }
    }

    const moreCpNote = byId('moreCompanyNote');
    if (moreCpNote) moreCpNote.hidden = !isGlobal;

    const globalWorkerNotice = byId('globalWorkerNotice');
    if (globalWorkerNotice) globalWorkerNotice.hidden = !isGlobal;

    byId('companyAdminManagement').hidden = !state.access.isGlobalAdmin;
    document.querySelector('[data-go="system"]')?.toggleAttribute('hidden', !state.access.isGlobalAdmin);
  }

  function showView(view) {
    if (view === 'bindings' || view === 'balances') {
      view = 'workers';
    } else if (view === 'tickets') {
      view = 'overview';
    } else if (view === 'admin') {
      view = 'more';
    }

    if (view !== 'company-profile' && !Object.hasOwn(loaders, view)) return;
    if (state.access?.isGlobalAdmin === false && view === 'system') return;

    const isGlobal = state.access?.isGlobalAdmin === true;
    const factoryViews = ['workers', 'models', 'parties'];

    // System admin manages factory workforce/batches inside Company Profile
    if (isGlobal && factoryViews.includes(view)) {
      if (state.selectedCompanyId) {
        void openCompanyProfile(state.selectedCompanyId).then(() => {
          void switchCpTab(view);
        });
        return;
      }
      view = 'companies';
      toast('Ishchilar va zavod amallari korxona profili ichida ochiladi. Kerakli korxonani tanlang.');
    }

    state.previousView = state.currentView;
    state.currentView = view;
    for (const section of document.querySelectorAll('[data-section]')) {
      const visible = section.dataset.section === view;
      section.hidden = !visible;
      section.classList.toggle('is-visible', visible);
    }
    const primaryMobileViews = isGlobal
      ? ['overview', 'companies', 'devices', 'activations', 'more']
      : ['overview', 'workers', 'parties', 'models', 'more'];
    for (const button of document.querySelectorAll('.nav-button')) {
      const v = button.dataset.view;
      const isPrimary = primaryMobileViews.includes(v);
      button.classList.toggle('mobile-primary-tab', isPrimary);
      const active = v === view || (v === 'more' && !primaryMobileViews.includes(view));
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    const labels = {
      overview: 'Umumiy',
      devices: 'Qurilmalar',
      companies: 'Korxonalar',
      'company-profile': 'Kompaniya profili',
      workers: 'Ishchilar va hisob-kitob',
      models: 'Modellar',
      parties: 'Partiyalar',
      activations: isGlobal ? 'Litsenziya' : 'Kalitlar & aktivatsiya',
      system: 'Tizim',
      more: 'Yana'
    };
    setText('currentViewLabel', labels[view] || view);
    setText('mobileViewTitle', labels[view] || view);
    const isRootHome = view === 'overview';
    const mobileBack = byId('mobileBackButton');
    if (mobileBack) mobileBack.hidden = isRootHome;
    const mobileTitle = byId('mobileViewTitle');
    if (mobileTitle) mobileTitle.hidden = isRootHome;
    if (telegram?.BackButton) {
      if (isRootHome) telegram.BackButton.hide();
      else telegram.BackButton.show();
    }
    if (typeof window !== 'undefined' && window.scrollTo) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    void loadCurrentView();
  }

  function enforceLightModeTheme() {
    try {
      document.documentElement.style.setProperty('color-scheme', 'light', 'important');
      document.body.style.setProperty('color', '#2c354f', 'important');
      if (telegram) {
        telegram.setHeaderColor?.('#0b132b');
        const isMobile = typeof window !== 'undefined' && window.innerWidth <= 820;
        telegram.setBackgroundColor?.(isMobile ? '#f4f6fa' : '#0b132b');
      }
    } catch { }
  }

  async function beginAuthentication() {
    enforceLightModeTheme();
    byId('authError').hidden = true;
    byId('retryAuth').hidden = true;
    byId('authMessage').textContent = 'Telegram administrator identity tekshirilmoqda…';
    if (!telegram || typeof telegram.initData !== 'string' || !telegram.initData) {
      showAuthError('Panelni @hisobmonitoringbot Telegram WebApp tugmasi orqali oching.', false);
      return;
    }
    try {
      telegram.ready();
      telegram.expand();
      try {
        telegram.enableClosingConfirmation?.();
        enforceLightModeTheme();
        if (telegram.BackButton) {
          telegram.BackButton.onClick(() => { handleNavigateBack(); });
        }
        telegram.onEvent?.('themeChanged', enforceLightModeTheme);
      } catch { }
      const result = await request(`${API}/session`, {
        method: 'POST', auth: false, body: { initData: telegram.initData }
      });
      state.sessionToken = result.session.token;
      state.expiresAt = result.session.expiresAt;
      state.user = result.user;
      state.access = result.access;
      const session = await request(`${API}/session`);
      if (session.session.telegramId !== state.user.id) throw new Error('ADMIN_SESSION_INVALID');
      state.access = session.access || state.access;
      if (!state.access) throw new Error('ADMIN_SESSION_INVALID');
      applyRoleNavigation();
      if (!state.access.isGlobalAdmin && state.access.companyIds?.length === 1) {
        const companyId = state.access.companyIds[0];
        const workerCompany = byId('workerFilterForm').elements.companyId;
        const payrollCompany = byId('payrollForm').elements.companyId;
        workerCompany.value = companyId;
        payrollCompany.value = companyId;
        workerCompany.readOnly = true;
        payrollCompany.readOnly = true;
      }
      byId('authGate').hidden = true;
      byId('adminApp').hidden = false;
      setText('adminBadge', state.access.isGlobalAdmin ? 'SYSTEM' : (state.user.firstName || state.user.username || 'Admin'));
      const defaultView = 'overview';
      showView(defaultView);
      if (telegram.BackButton) telegram.BackButton.hide();
    } catch (error) {
      state.sessionToken = '';
      state.expiresAt = 0;
      state.user = null;
      state.access = null;
      showAuthError(error.code === 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED'
        ? 'Ushbu Telegram akkaunti admin allowlistida yo‘q.'
        : 'Autentifikatsiya yakunlanmadi.  API va Telegram ruxsatini tekshiring.', true);
    }
  }

  async function submitCompany(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const roles = data.getAll('allowedRoles');
    if (!data.get('companyId')) { toast('Mavjud biznes scope tanlang.'); return; }
    if (!roles.length) { toast('Kamida bitta rolni tanlang.'); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await request(`${API}/companies`, {
        method: 'POST',
        body: {
          companyId: String(data.get('companyId') || '').trim(),
          companyName: String(data.get('companyName') || '').trim(),
          allowedRoles: roles,
          isActive: data.get('isActive') === 'on'
        }
      });
      toast('Aktivatsiya siyosati saqlandi.');
      await loadCompanies();
    } catch (error) {
      toast(`Saqlanmadi: ${error.code || 'API_UNAVAILABLE'}`);
    } finally {
      button.disabled = false;
    }
  }

  async function submitWorkerFilter(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      state.workerOffset = 0;
      await loadWorkers({ companyId: String(data.get('companyId') || '').trim(), search: String(data.get('search') || '').trim() });
    } catch (error) { toast(`Ishchi ro‘yxati olinmadi: ${error.code || 'API_UNAVAILABLE'}`); }
  }

  async function submitPayroll(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await loadPayroll({ companyId: String(data.get('companyId') || '').trim(), periodId: String(data.get('periodId') || '').trim() });
    } catch (error) { toast(`Hisob olinmadi: ${error.code || 'API_UNAVAILABLE'}`); }
  }

  function selectedActivation() {
    const requestId = byId('activationRequestSelect').value;
    return state.activations.find((item) => item.requestId === requestId) || null;
  }

  async function submitActivationAction(action) {
    if (state.activationSubmitting) return;
    const selected = selectedActivation();
    if (!selected) { toast('Aktivatsiya so‘rovini tanlang.'); return; }
    const form = byId('activationForm');
    const data = new FormData(form);
    const button = action === 'approve' ? byId('approveActivation') : action === 'reject' ? byId('rejectActivation') : byId('revokeActivation');
    if (action === 'approve' && !data.get('companyId')) { toast('Tasdiqlashdan oldin  kompaniyasini tanlang.'); return; }
    if (action === 'reject' && !String(data.get('reason') || '').trim()) { toast('Rad etish sababini kiriting.'); return; }
    if ((action === 'approve' && selected.status !== 'PENDING')
      || (action === 'reject' && selected.status !== 'PENDING')
      || (action === 'revoke' && selected.status !== 'APPROVED')) {
      toast('Tanlangan so‘rov holati bu amal uchun mos emas.');
      return;
    }
    const confirmation = action === 'approve' ? 'Ushbu qurilma aktivatsiyasini tasdiqlaysizmi?' : action === 'reject' ? 'Ushbu aktivatsiya so‘rovini rad etasizmi?' : 'Ushbu qurilma aktivatsiyasini bekor qilasizmi?';
    if (!window.confirm(confirmation)) return;
    state.activationSubmitting = true;
    for (const actionButton of [byId('approveActivation'), byId('rejectActivation'), byId('revokeActivation')]) actionButton.disabled = true;
    let actionSucceeded = false;
    try {
      const body = action === 'approve'
        ? { companyId: String(data.get('companyId')), role: String(data.get('role')) }
        : action === 'reject' ? { companyId: String(data.get('companyId') || ''), reason: String(data.get('reason')).trim() } : {};
      await request(`${API}/activations/${encodeURIComponent(selected.requestId)}/${action}`, { method: 'POST', body });
      selected.status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'REVOKED';
      if (action === 'approve') {
        selected.companyId = String(data.get('companyId'));
        selected.role = String(data.get('role'));
      }
      actionSucceeded = true;
      toast(action === 'approve' ? 'Aktivatsiya tasdiqlandi.' : action === 'reject' ? 'So‘rov rad etildi.' : 'Aktivatsiya bekor qilindi.');
    } catch (error) {
      toast(`Amal bajarilmadi: ${error.code || 'API_UNAVAILABLE'}`);
    } finally {
      state.activationSubmitting = false;
      const current = selectedActivation();
      byId('approveActivation').disabled = !current || current.status !== 'PENDING';
      byId('rejectActivation').disabled = !current || current.status !== 'PENDING';
      byId('revokeActivation').disabled = !current || current.status !== 'APPROVED';
    }
    if (actionSucceeded) {
      try { await Promise.all([loadActivations(), loadOverview()]); }
      catch (error) { toast(`Amal bajarildi, ro‘yxat yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    }
  }

  function bindEvents() {
    byId('retryAuth').addEventListener('click', () => { void beginAuthentication(); });
    byId('refreshButton').addEventListener('click', () => {
      try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
      void loadCurrentView();
    });
    byId('sysRefreshBtn')?.addEventListener('click', () => {
      try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
      void loadCurrentView();
    });
    byId('mobileBackButton')?.addEventListener('click', () => { handleNavigateBack(); });
    byId('mainNav').addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (button) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        showView(button.dataset.view);
      }
    });
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-go]');
      if (target) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        showView(target.dataset.go);
      }
      const openCompanyBtn = event.target.closest('[data-open-company]');
      if (openCompanyBtn) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        openCompanyProfile(openCompanyBtn.dataset.openCompany);
        return;
      }
      const companyCard = event.target.closest('.company-card');
      if (companyCard && !event.target.closest('button')) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        openCompanyProfile(companyCard.dataset.companyId);
        return;
      }
      const cpTabBtn = event.target.closest('[data-cp-tab]');
      if (cpTabBtn) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        switchCpTab(cpTabBtn.dataset.cpTab);
        return;
      }
      const switchCpBtn = event.target.closest('[data-switch-cp-tab]');
      if (switchCpBtn) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        switchCpTab(switchCpBtn.dataset.switchCpTab);
        return;
      }
      const cpSubBtn = event.target.closest('[data-open-cp-sub]');
      if (cpSubBtn) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
        const sub = cpSubBtn.dataset.openCpSub;
        state.currentCpTab = sub;
        showView('company-profile');
        void switchCpTab(sub);
        return;
      }
      const dirQuickAdj = event.target.closest('#dirQuickAdjBtn');
      if (dirQuickAdj) {
        openQuickAdjustment({ companyId: state.access?.companyIds?.[0] });
        return;
      }
      const cpQuickAdj = event.target.closest('#cpQuickAdjBtn');
      if (cpQuickAdj) {
        openQuickAdjustment({ companyId: state.selectedCompanyId });
        return;
      }
      const quickAdjBtn = event.target.closest('[data-quick-adj]');
      if (quickAdjBtn) {
        const { quickAdj, companyId, workerName } = quickAdjBtn.dataset;
        openQuickAdjustment({ workerId: quickAdj, companyId, workerName });
        return;
      }
      const amountChip = event.target.closest('.amount-chip');
      if (amountChip) {
        const amountInput = byId('quickAdjAmount');
        if (amountInput) amountInput.value = amountChip.dataset.amount;
        return;
      }
      const selectActBtn = event.target.closest('[data-select-activation]');
      if (selectActBtn) {
        const reqId = selectActBtn.dataset.selectActivation;
        showView('activations');
        window.setTimeout(() => {
          const select = byId('activationRequestSelect');
          if (select) {
            select.value = reqId;
            syncActivationControls();
            byId('activationForm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 120);
      }
      const selectRequestBtn = event.target.closest('[data-select-request]');
      if (selectRequestBtn) {
        const reqId = selectRequestBtn.dataset.selectRequest;
        const select = byId('activationRequestSelect');
        if (select) {
          select.value = reqId;
          syncActivationControls();
          byId('activationForm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      const editCompanyBtn = event.target.closest('[data-edit-company]');
      if (editCompanyBtn) {
        const compId = editCompanyBtn.dataset.editCompany;
        const select = byId('companyPolicySelect');
        if (select) {
          select.value = compId;
          select.dispatchEvent(new Event('change'));
          byId('companyForm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      const eventButton = event.target.closest('[data-events-request]');
      if (eventButton) void showActivationEvents(eventButton.dataset.eventsRequest).catch((error) => toast(`Audit olinmadi: ${error.code || 'API_UNAVAILABLE'}`));
      const editWorkerButton = event.target.closest('[data-edit-worker]');
      if (editWorkerButton) openWorkerDialog(editWorkerButton.dataset.editWorker, editWorkerButton.dataset.companyId);
      const unbindButton = event.target.closest('[data-unbind-worker]');
      if (unbindButton) void unbindWorker(unbindButton);
      const companyAdminButton = event.target.closest('[data-company-admin-id]');
      if (companyAdminButton) {
        const { companyId, companyAdminId, active } = companyAdminButton.dataset;
        const isActive = active === 'true';
        const operation = async () => {
          companyAdminButton.disabled = true;
          let changed = false;
          try {
            await request(`${API}/companies/${encodeURIComponent(companyId)}/admins/${encodeURIComponent(companyAdminId)}`, {
              method: 'PUT', body: { isActive }
            });
            changed = true;
            toast(isActive ? 'Kompaniya admini faollashtirildi.' : 'Kompaniya admini bekor qilindi.');
          } catch (error) { toast(`Ruxsat o‘zgarmadi: ${error.code || 'API_UNAVAILABLE'}`); }
          finally { companyAdminButton.disabled = false; }
          if (changed) {
            try { await loadCompanyAdmins(companyId); }
            catch (error) { toast(`Ruxsat o‘zgartirildi, ro‘yxat yangilanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
          }
        };
        if (isActive || window.confirm(`${companyAdminId} admin huquqini bekor qilasizmi?`)) void operation();
      }
    });
    byId('companyForm').addEventListener('submit', (event) => { void submitCompany(event); });
    byId('companyPolicySelect').addEventListener('change', (event) => {
      const companyId = event.currentTarget.value;
      const company = state.companies.find((item) => item.companyId === companyId && item.businessScopeExists);
      byId('companyPolicyName').value = company?.companyName || companyId;
      for (const checkbox of document.querySelectorAll('input[name="allowedRoles"]')) checkbox.checked = !company?.activationConfigured || Boolean(company?.allowedRoles?.includes(checkbox.value));
      byId('companyForm').elements.isActive.checked = company?.activationConfigured ? company.activationActive : true;
    });
    byId('companyAdminForm').addEventListener('submit', (event) => { void submitCompanyAdmin(event); });
    byId('companyAdminCompany').addEventListener('change', (event) => {
      if (event.currentTarget.value) void loadCompanyAdmins(event.currentTarget.value).catch((error) => toast(`Adminlar olinmadi: ${error.code || 'API_UNAVAILABLE'}`));
    });
    byId('activationRequestSelect').addEventListener('change', () => {
      syncActivationControls();
    });
    byId('workerFilterForm').addEventListener('submit', (event) => { void submitWorkerFilter(event); });
    byId('workerPrevious').addEventListener('click', () => { state.workerOffset = Math.max(0, state.workerOffset - 50); void loadWorkers(); });
    byId('workerNext').addEventListener('click', () => { state.workerOffset += 50; void loadWorkers(); });
    byId('bindingPrevious').addEventListener('click', () => { state.bindingOffset = Math.max(0, state.bindingOffset - 50); void loadBindings(); });
    byId('bindingNext').addEventListener('click', () => { state.bindingOffset += 50; void loadBindings(); });
    byId('payrollForm').addEventListener('submit', (event) => { void submitPayroll(event); });
    byId('activationStatusFilter').addEventListener('change', () => { void loadActivations(); });
    byId('balanceCompanySelect').addEventListener('change', () => {
      state.balanceWorkerSearch = '';
      byId('balanceWorkerSearch').value = '';
      byId('balanceViewPeriodSelect').value = '';
      byId('balancePeriodSelect').value = '';
      void loadBalances().catch((error) => toast(`Avans/jarima ma’lumotlari olinmadi: ${error.code || 'API_UNAVAILABLE'}`));
    });
    byId('balanceViewPeriodSelect').addEventListener('change', () => {
      void loadBalances().catch((error) => toast(`Davr balansi olinmadi: ${error.code || 'API_UNAVAILABLE'}`));
    });
    byId('balanceWorkerSearchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const search = String(new FormData(event.currentTarget).get('search') || '');
      void loadBalanceWorkers(search).catch((error) => toast(`Ishchilar olinmadi: ${error.code || 'API_UNAVAILABLE'}`));
    });
    byId('balanceAdjustmentForm').addEventListener('submit', (event) => { void submitBalanceAdjustment(event); });
    byId('approveActivation').addEventListener('click', () => { void submitActivationAction('approve'); });
    byId('rejectActivation').addEventListener('click', () => { void submitActivationAction('reject'); });
    byId('revokeActivation').addEventListener('click', () => { void submitActivationAction('revoke'); });
    byId('signOutButton').addEventListener('click', () => clearSession('Sessiya yopildi. Panelni Telegram’dan qayta oching.'));
    byId('workerEditForm').addEventListener('submit', (event) => { void submitWorkerEdit(event); });
    byId('workerStatusButton').addEventListener('click', () => { void changeWorkerStatus(); });
    byId('closeWorkerDialog').addEventListener('click', () => byId('workerDialog').close());

    // Company Directory & Profile Events
    byId('companySearchInput')?.addEventListener('input', (event) => {
      state.companySearchQuery = event.target.value;
      renderCompanyCards();
    });
    byId('companyFilterChips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-company-filter]');
      if (!chip) return;
      for (const c of document.querySelectorAll('#companyFilterChips .chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
      state.companyFilter = chip.dataset.companyFilter;
      renderCompanyCards();
    });
    byId('cpWorkerSearchInput')?.addEventListener('input', (event) => {
      state.cpWorkerSearchQuery = event.target.value;
      renderCpWorkerCards();
    });
    byId('closeQuickAdjDialog')?.addEventListener('click', () => byId('quickAdjustmentDialog').close());
    byId('cancelQuickAdj')?.addEventListener('click', () => byId('quickAdjustmentDialog').close());
    byId('quickAdjustmentForm')?.addEventListener('submit', (e) => submitQuickAdjustment(e));
    byId('cpAdminAssignForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = new FormData(form);
      const companyId = state.selectedCompanyId;
      const telegramId = String(data.get('telegramId') || '').trim();
      if (!companyId || !/^\d{1,24}$/.test(telegramId)) { toast('To‘g‘ri Telegram ID kiriting.'); return; }
      try {
        await request(`${API}/companies/${encodeURIComponent(companyId)}/admins/${encodeURIComponent(telegramId)}`, {
          method: 'PUT', body: { isActive: true }
        });
        byId('cpAdminTelegramInput').value = '';
        toast('Admin biriktirildi.');
        await loadCpAdmins(companyId);
      } catch (err) {
        toast(`Admin biriktirilmadi: ${err.code || 'API_UNAVAILABLE'}`);
      }
    });
    byId('cpPolicyForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = new FormData(form);
      const companyId = state.selectedCompanyId;
      const companyName = String(data.get('companyName') || '').trim();
      const roles = data.getAll('allowedRoles');
      const isActive = byId('cpPolicyActiveInput').checked;
      if (!companyId || !companyName) { toast('Nomini kiriting.'); return; }
      try {
        await request(`${API}/companies`, {
          method: 'POST',
          body: { companyId, companyName, allowedRoles: roles, isActive }
        });
        toast('Siyosat saqlandi.');
        await loadCompanyProfile(companyId);
      } catch (err) {
        toast(`Siyosat saqlanmadi: ${err.code || 'API_UNAVAILABLE'}`);
      }
    });

    // Redesign: Co-Overview Refresh
    byId('coRefreshBtn')?.addEventListener('click', () => {
      try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
      void loadCurrentView();
    });
    byId('coReturnToGlobalBtn')?.addEventListener('click', () => {
      try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch { }
      state.selectedCompanyId = null;
      showView('overview');
    });

    // Redesign: Worker Subtabs (Ro'yxat vs Oyliklar)
    byId('workerSubTabs')?.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-worker-subtab]');
      if (!tab) return;
      for (const t of document.querySelectorAll('#workerSubTabs .segmented-tab')) t.classList.remove('is-active');
      tab.classList.add('is-active');
      state.workerSubTab = tab.dataset.workerSubtab;
      const isPayroll = state.workerSubTab === 'payroll';
      const listPane = byId('workerListSubPane');
      const payrollPane = byId('workerPayrollSubPane');
      if (listPane) listPane.hidden = isPayroll;
      if (payrollPane) payrollPane.hidden = !isPayroll;
      if (isPayroll) {
        const companyId = state.access?.companyIds?.[0] || state.companies?.[0]?.companyId;
        if (companyId) void loadPayroll({ companyId });
      }
    });

    // Redesign: Worker Filter Chips & Search
    byId('workerFilterChips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-worker-filter]');
      if (!chip) return;
      for (const c of document.querySelectorAll('#workerFilterChips .chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
      state.workerFilter = chip.dataset.workerFilter;
      void loadWorkers();
    });
    byId('workerSearchInput')?.addEventListener('input', (event) => {
      state.workerSearchQuery = event.target.value;
      void loadWorkers();
    });
    byId('payrollWorkerSearchInput')?.addEventListener('input', (event) => {
      state.payrollSearchQuery = event.target.value;
      const companyId = state.access?.companyIds?.[0] || state.companies?.[0]?.companyId;
      if (companyId) void loadPayroll({ companyId });
    });

    // Redesign: Month Navigation
    const monthNames = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
    const updatePayrollMonthLabel = () => {
      const d = new Date();
      d.setMonth(d.getMonth() + state.payrollMonthOffset);
      const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
      setText('payrollMonthLabel', label);
    };
    updatePayrollMonthLabel();
    byId('payrollMonthPrev')?.addEventListener('click', () => {
      state.payrollMonthOffset -= 1;
      updatePayrollMonthLabel();
      const companyId = state.access?.companyIds?.[0] || state.companies?.[0]?.companyId;
      if (companyId) void loadPayroll({ companyId });
    });
    byId('payrollMonthNext')?.addEventListener('click', () => {
      state.payrollMonthOffset += 1;
      updatePayrollMonthLabel();
      const companyId = state.access?.companyIds?.[0] || state.companies?.[0]?.companyId;
      if (companyId) void loadPayroll({ companyId });
    });

    // Redesign: Salary Detail Dialog Handlers
    byId('closeSalaryDetailDialog')?.addEventListener('click', () => {
      byId('workerSalaryDetailDialog')?.close();
    });
    byId('wsdAddAdjustmentBtn')?.addEventListener('click', () => {
      byId('workerSalaryDetailDialog')?.close();
      if (state.selectedWorkerPayroll) {
        openQuickAdjustment({
          workerId: String(state.selectedWorkerPayroll.workerId),
          companyId: state.selectedWorkerPayroll.companyId || state.access?.companyIds?.[0],
          workerName: state.selectedWorkerPayroll.name
        });
      }
    });

    // Redesign: Device Filter Chips & Search
    byId('deviceFilterChips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-device-filter]');
      if (!chip) return;
      for (const c of document.querySelectorAll('#deviceFilterChips .chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
      state.deviceFilter = chip.dataset.deviceFilter;
      void loadDevices();
    });
    byId('deviceSearchInput')?.addEventListener('input', (event) => {
      state.deviceSearchQuery = event.target.value;
      void loadDevices();
    });

    // Redesign: Party Filter Chips & Search
    byId('partyFilterChips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-party-filter]');
      if (!chip) return;
      for (const c of document.querySelectorAll('#partyFilterChips .chip')) c.classList.remove('is-active');
      chip.classList.add('is-active');
      state.partyFilter = chip.dataset.partyFilter;
      void loadParties();
    });
    byId('partySearchInput')?.addEventListener('input', (event) => {
      state.partySearchQuery = event.target.value;
      void loadParties();
    });

    // Redesign: Model Search
    byId('modelSearchInput')?.addEventListener('input', (event) => {
      state.modelSearchQuery = event.target.value;
      void loadModels();
    });

    // Redesign: Activation Subtabs
    byId('activationSubTabs')?.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-act-subtab]');
      if (!tab) return;
      for (const t of document.querySelectorAll('#activationSubTabs .segmented-tab')) t.classList.remove('is-active');
      tab.classList.add('is-active');
      state.actSubTab = tab.dataset.actSubtab;
      const isPolicy = state.actSubTab === 'policy';
      const isGlobal = Boolean(state.access?.isGlobalAdmin);
      const reqPane = byId('actRequestsPane');
      const polPane = byId('actPolicyPane');
      if (isGlobal) {
        if (reqPane) reqPane.hidden = false;
        if (polPane) polPane.hidden = true;
        if (isPolicy) byId('expiringLicensesSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        if (reqPane) reqPane.hidden = isPolicy;
        if (polPane) polPane.hidden = !isPolicy;
      }
    });

    // Redesign: Mobile Activation Policy Save
    byId('actPolicyMobileSaveBtn')?.addEventListener('click', async () => {
      const companyId = state.access?.companyIds?.[0] || state.companies?.[0]?.companyId;
      const targetCo = (state.companies || []).find((c) => c.companyId === companyId);
      const companyName = byId('actPolicyMobileName')?.value?.trim() || targetCo?.companyName || (companyId ? `Korxona (${companyId})` : 'Korxona');
      const isActive = byId('actPolicyMobileActive')?.checked ?? true;
      const roles = [...document.querySelectorAll('input[name="actMobileRoles"]:checked')].map((el) => el.value);
      if (!companyId) { toast('Kompaniya topilmadi.'); return; }
      try {
        await request(`${API}/companies`, {
          method: 'POST',
          body: { companyId, companyName, allowedRoles: roles, isActive }
        });
        toast('Siyosat saqlandi.');
        void loadActivations();
      } catch (err) {
        toast(`Siyosat saqlanmadi: ${err.code || 'API_UNAVAILABLE'}`);
      }
    });

    // Redesign: System Restart Sync
    byId('btnRestartSync')?.addEventListener('click', () => {
      try { telegram?.HapticFeedback?.notificationOccurred?.('success'); } catch { }
      toast('Sinxronlash qayta ishga tushirildi.');
      void loadSystem();
    });

    // Redesign: Yana Sign Out
    byId('moreSignOutBtn')?.addEventListener('click', () => {
      clearSession('Sessiya yopildi. Panelni Telegram’dan qayta oching.');
    });

    // Browser Online/Offline Connectivity
    window.addEventListener('online', () => setOnlineStatus(true, 'Ulangan'));
    window.addEventListener('offline', () => setOnlineStatus(false, 'Oflayn'));
    setOnlineStatus(navigator.onLine !== false, navigator.onLine !== false ? 'Ulangan' : 'Oflayn');
  }

  enforceLightModeTheme();
  bindEvents();
  void beginAuthentication();
})();
