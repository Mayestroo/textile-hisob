(() => {
  'use strict';

  const API = '/api/admin/webapp';
  const telegram = window.Telegram && window.Telegram.WebApp;
  const state = {
    sessionToken: '',
    expiresAt: 0,
    user: null,
    sessionActorId: '',
    access: null
  };

  const byId = (id) => document.getElementById(id);

  function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function payrollIncomplete(worker) { return worker?.accountingStatus === 'INCOMPLETE' || worker?.accountingStatus === 'UNAVAILABLE' || !worker?.accountingStatus; }
  function payrollAmount(worker, value) { return `${value}${payrollIncomplete(worker) ? ' (oraliq, tasdiqlanmagan)' : ''}`; }
  function payrollWarning(workers, payroll) {
    const count = workers.reduce((sum, worker) => sum + (payrollIncomplete(worker) ? Number(worker.unknownEntryCount || 0) : 0), 0);
    if (payroll && !payroll.period) return ' · ⚠️ Davr mavjud emas; oylik hisoblanmagan.';
    return workers.some(payrollIncomplete) || (payroll && payroll.accountingStatus !== 'COMPLETE')
      ? ` · ⚠️ Hisob to‘liq emas: ${count} ta ish narxi noma’lum, ${workers.reduce((sum, worker) => sum + Number(worker.unresolvedAdjustmentCount || 0), 0)} ta tuzatish aniqlanmagan. Summalar faqat aniqlangan ishlar bo‘yicha oraliq hisob, yakuniy oylik emas.` : '';
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

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }

  function number(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Math.round(amount).toLocaleString('uz-UZ') : '0';
  }

  function showAuthError(message, retry = true) {
    byId('authGate').hidden = false;
    byId('companyAdminApp').hidden = true;
    byId('companyPicker').hidden = true;
    document.body.classList.remove('company-admin-session');
    byId('authMessage').textContent = message;
    byId('authError').hidden = false;
    byId('authError').textContent = 'Kirish rad etildi. Himoyalangan ma’lumot ko‘rsatilmaydi.';
    byId('retryAuth').hidden = !retry;
  }

  function clearSession(message) {
    state.sessionToken = '';
    state.expiresAt = 0;
    state.user = null;
    state.sessionActorId = '';
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
      error.status = response.status;
      throw error;
    }
    return result;
  }

  // Persistent within this browser; actor/company scoped, and Web Locks serialize tabs.
  let financialIntents = null;
  try { financialIntents = window.NovdaFinancialIntent.create(window.localStorage, navigator.locks); }
  catch { /* Keep nonfinancial views available if browser storage is disabled. */ }
  const financialInFlight = new Set();
  function financialScope(companyId, kind) {
    if (!financialIntents) throw new Error('FINANCIAL_INTENT_STORAGE_UNAVAILABLE');
    if (!state.sessionToken || !state.user?.id || state.sessionActorId !== String(state.user.id) || !companyId
      || !state.access?.companyIds?.includes(companyId)
      || companyPanel.companyId !== companyId) throw new Error('FINANCIAL_INTENT_SCOPE_CHANGED');
    return { actor: String(state.user.id), companyId, kind, token: state.sessionToken };
  }
  function sameFinancialScope(scope) {
    try {
      const current = financialScope(scope.companyId, scope.kind);
      return current.actor === scope.actor && current.token === scope.token;
    } catch { return false; }
  }
  async function sendFinancialIntent(scope, draft, build, workerId) {
    const key = JSON.stringify([scope.actor, scope.companyId, scope.kind]);
    if (financialInFlight.has(key)) throw new Error('FINANCIAL_INTENT_IN_FLIGHT');
    financialInFlight.add(key);
    try {
      return await financialIntents.run(scope, async () => {
        if (!sameFinancialScope(scope)) throw new Error('FINANCIAL_INTENT_SCOPE_CHANGED');
        const createIntent = () => financialIntents.prepare(scope, draft, async () => {
          const body = await build();
          if (!sameFinancialScope(scope)) throw new Error('FINANCIAL_INTENT_SCOPE_CHANGED');
          return body;
        });
        let intent;
        try { intent = await createIntent(); }
        catch (error) {
          if (error.message !== 'FINANCIAL_INTENT_ALREADY_COMPLETED'
            || !sameFinancialScope(scope)
            || !window.confirm('Bu miqdor va izoh bilan amal allaqachon saqlangan. Yangi alohida amalni boshlaysizmi?')) throw error;
          const body = await build();
          if (!sameFinancialScope(scope)) throw new Error('FINANCIAL_INTENT_SCOPE_CHANGED');
          intent = financialIntents.acknowledge(scope, draft, body);
        }
        if (!sameFinancialScope(scope)) throw new Error('FINANCIAL_INTENT_SCOPE_CHANGED');
        financialIntents.attempt(scope, intent.body.operationId); // Persist before touching the network.
        try {
          const result = await request(`${API}/companies/${encodeURIComponent(scope.companyId)}/workers/${encodeURIComponent(workerId)}`,
            { method: 'PUT', body: intent.body });
          financialIntents.complete(scope, intent.body.operationId);
          return result;
        } catch (error) {
          financialIntents.reject(scope, intent.body.operationId, error.status);
          if (financialIntents.pending(scope)?.body?.operationId === intent.body.operationId)
            financialIntents.uncertain(scope, intent.body.operationId);
          throw error;
        }
      });
    } finally { financialInFlight.delete(key); }
  }

  function withQuery(route, values) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values || {})) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    return suffix ? `${route}?${suffix}` : route;
  }

  function handleNavigateBack() {
    if (document.querySelector('[data-co-screen="advance-success"].is-active')) {
      if (companyPanel.selectedWorker) openCompanyWorker(companyPanel.selectedWorker);
      else coShowScreen('workers');
    } else if (document.querySelector('[data-co-screen="advance"].is-active')) {
      if (companyPanel.selectedWorker) coShowScreen('worker-detail', 'workers');
      else coShowScreen('workers');
    } else if (document.querySelector('[data-co-screen="tickets"].is-active')) coShowScreen('worker-detail', 'workers');
    else if (document.querySelector('[data-co-screen="worker-detail"].is-active')) coShowScreen('workers');
    else if (!document.querySelector('[data-co-screen="home"].is-active')) coShowScreen('home');
    else { try { telegram?.close?.(); } catch { } }
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

  const companyPanel = {
    companyId: '', periodId: '', periods: [], workers: [], payroll: [], parties: [], models: [],
    tickets: [], selectedWorker: null, selectedModel: null, workerFilter: 'all', partyFilter: 'active',
    workerQuery: '', visibleOperations: 5
  };

  function coText(tag, className, text) { return node(tag, className, text); }
  function coMoney(value) { return number(Math.round(Number(value) || 0)); }
  function coToast(message) {
    const toastNode = byId('companyToast');
    if (!toastNode) return;
    toastNode.textContent = message;
    toastNode.hidden = false;
    window.clearTimeout(companyPanel.toastTimer);
    companyPanel.toastTimer = window.setTimeout(() => { toastNode.hidden = true; }, 3000);
  }
  function coShowScreen(name, tab = null) {
    for (const screen of document.querySelectorAll('.co-screen')) screen.classList.toggle('is-active', screen.dataset.coScreen === name);
    for (const button of document.querySelectorAll('.co-bottom-nav [data-co-tab]')) button.classList.toggle('selected', button.dataset.coTab === (tab || name));
    const isSubscreen = name === 'models' || name === 'worker-detail' || name === 'tickets' || name === 'advance' || name === 'advance-success';
    const bottomNav = document.querySelector('.co-bottom-nav');
    if (bottomNav) bottomNav.hidden = isSubscreen;
    const app = document.querySelector('.company-app');
    if (app) app.classList.toggle('co-subscreen-view', isSubscreen);
    const backBtn = byId('companyClose');
    const avatar = byId('companyAvatar');
    if (backBtn) {
      backBtn.classList.toggle('is-hidden', !isSubscreen);
      if (name === 'advance' || name === 'advance-success') {
        backBtn.classList.add('co-close-advance');
        backBtn.setAttribute('aria-label', 'Yopish');
        const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        closeSvg.setAttribute('width', '14');
        closeSvg.setAttribute('height', '14');
        closeSvg.setAttribute('viewBox', '0 0 24 24');
        closeSvg.setAttribute('fill', 'none');
        closeSvg.setAttribute('stroke', 'currentColor');
        closeSvg.setAttribute('stroke-width', '2.5');
        closeSvg.setAttribute('stroke-linecap', 'round');
        closeSvg.setAttribute('stroke-linejoin', 'round');
        const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l1.setAttribute('x1', '18'); l1.setAttribute('y1', '6'); l1.setAttribute('x2', '6'); l1.setAttribute('y2', '18');
        const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l2.setAttribute('x1', '6'); l2.setAttribute('y1', '6'); l2.setAttribute('x2', '18'); l2.setAttribute('y2', '18');
        closeSvg.append(l1, l2);
        const closeSpan = document.createElement('span');
        closeSpan.textContent = 'Yopish';
        backBtn.replaceChildren(closeSvg, closeSpan);
      } else {
        backBtn.classList.remove('co-close-advance');
        backBtn.setAttribute('aria-label', 'Ortga');
        const backSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        backSvg.setAttribute('class', 'co-close-icon');
        backSvg.setAttribute('width', '16');
        backSvg.setAttribute('height', '16');
        backSvg.setAttribute('viewBox', '0 0 24 24');
        backSvg.setAttribute('fill', 'none');
        backSvg.setAttribute('stroke', 'currentColor');
        backSvg.setAttribute('stroke-width', '2.5');
        backSvg.setAttribute('stroke-linecap', 'round');
        backSvg.setAttribute('stroke-linejoin', 'round');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'm15 18-6-6 6-6');
        backSvg.append(p);
        const backSpan = document.createElement('span');
        backSpan.textContent = 'Ortga';
        backBtn.replaceChildren(backSvg, backSpan);
      }
    }
    if (avatar) {
      avatar.classList.toggle('co-avatar-advance', name === 'advance' || name === 'advance-success');
    }
    if (telegram?.BackButton) {
      if (isSubscreen) {
        try { telegram.BackButton.show(); } catch { }
      } else {
        try { telegram.BackButton.hide(); } catch { }
      }
    }
    if (telegram?.HapticFeedback) { try { telegram.HapticFeedback.impactOccurred('light'); } catch { } }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function coButton(tag, className, label, onClick) {
    const button = coText(tag, className, label);
    button.type = 'button'; button.addEventListener('click', onClick); return button;
  }
  function selectedPeriod() { return companyPanel.periods.find((period) => period.periodId === companyPanel.periodId) || null; }
  function payrollQuery() { return { companyId: companyPanel.companyId, ...(companyPanel.periodId ? { periodId: companyPanel.periodId } : {}) }; }
  function companyWorkerFilterKey() {
    return `hisob.company.worker-filter.v1:${JSON.stringify([state.sessionActorId || '', companyPanel.companyId || '', companyPanel.periodId || ''])}`;
  }
  function restoreCompanyWorkerFilter() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(companyWorkerFilterKey()) || 'null');
      if (saved && typeof saved.query === 'string' && ['all', 'positive', 'negative', 'zero'].includes(saved.filter)) {
        companyPanel.workerQuery = saved.query;
        companyPanel.workerFilter = saved.filter;
      } else {
        companyPanel.workerQuery = '';
        companyPanel.workerFilter = 'all';
      }
    } catch {
      companyPanel.workerQuery = '';
      companyPanel.workerFilter = 'all';
    }
    const search = byId('companyWorkerSearch');
    if (search) search.value = companyPanel.workerQuery;
    byId('companyWorkerFilters')?.querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item.dataset.filter === companyPanel.workerFilter));
  }
  function saveCompanyWorkerFilter() {
    try { window.sessionStorage.setItem(companyWorkerFilterKey(), JSON.stringify({ query: companyPanel.workerQuery, filter: companyPanel.workerFilter })); }
    catch { /* Filtering remains available when session storage is blocked. */ }
  }
  async function loadCompanyCollection(route, companyId, resultKey) {
    const limit = 100;
    const rows = [];
    let offset = 0;
    while (offset < 10000) {
      const result = await request(withQuery(route, { companyId, limit, offset }));
      const page = result[resultKey] || [];
      rows.push(...page);
      if (page.length < limit || (Number.isFinite(Number(result.total)) && rows.length >= Number(result.total))) break;
      offset += page.length;
    }
    return rows;
  }

  async function startCompanyAdminApp(companyId) {
    if (companyPanel.companyId !== companyId) {
      Object.assign(companyPanel, { periodId: '', periods: [], workers: [], payroll: [], parties: [],
        models: [], tickets: [], selectedWorker: null, selectedModel: null, advanceWorker: null,
        advanceTargetMode: false, workerFilter: 'all', partyFilter: 'active', workerQuery: '', visibleOperations: 5 });
    }
    companyPanel.companyId = companyId;
    const [companies, periods] = await Promise.all([
      request(`${API}/companies`),
      request(`${API}/companies/${encodeURIComponent(companyId)}/periods`)
    ]);
    const company = (companies?.companies || []).find((item) => item.companyId === companyId);
    const companyDisplayName = company?.companyName || companyId || 'Kompaniya';
    setText('companyBrandName', companyDisplayName);
    const userRoleText = state.user?.firstName ? `${state.user.firstName} · Admin` : 'Admin';
    setText('companyBrandRole', userRoleText);
    const avatar = byId('companyAvatar');
    if (avatar) {
      avatar.textContent = (companyDisplayName || 'N').trim().charAt(0).toUpperCase();
    }
    const licenseActive = Boolean(company?.activationConfigured && company?.activationActive);
    setText('companyLicenseStatus', company?.activationConfigured ? (licenseActive ? 'Faol' : 'Nofaol') : 'Sozlanmagan');
    setText('companyLicenseBadge', company?.activationConfigured ? (licenseActive ? 'Faol' : 'Nofaol') : '—');
    void refreshWorkerBotStatus();
    companyPanel.periods = periods.periods || [];
    companyPanel.periodId = companyPanel.periods.find((period) => !period.isClosed)?.periodId || companyPanel.periods[0]?.periodId || '';
    restoreCompanyWorkerFilter();
    const select = byId('companyPeriodSelect');
    select.replaceChildren();
    for (const period of companyPanel.periods) {
      let label = period.name || 'Davr';
      if (period.startDate && !label.includes('20')) {
        const year = String(period.startDate).slice(0, 4);
        label = `${year} — ${label}`;
      }
      const option = node('option', '', `${label}${period.isClosed ? ' · yopilgan' : ''}`);
      option.value = period.periodId; select.appendChild(option);
    }
    if (!companyPanel.periods.length) {
      const option = node('option', '', 'Davr mavjud emas'); option.value = ''; select.appendChild(option);
    }
    select.value = companyPanel.periodId;
    await loadCompanyAdminData({ throwOnError: true });
  }

  async function loadCompanyAdminData({ throwOnError = false } = {}) {
    const { companyId } = companyPanel;
    try {
      const [payrollRes, workers, parties, models, tickets] = await Promise.all([
        request(withQuery(`${API}/payroll`, payrollQuery())),
        loadCompanyCollection(`${API}/workers`, companyId, 'workers'),
        loadCompanyCollection(`${API}/parties`, companyId, 'parties'),
        loadCompanyCollection(`${API}/models`, companyId, 'models'),
        loadCompanyCollection(`${API}/tickets`, companyId, 'tickets')
      ]);
      companyPanel.payroll = payrollRes.payroll?.workers || [];
      const payrollMap = new Map(companyPanel.payroll.map((worker) => [String(worker.workerId), worker]));
      companyPanel.workers = workers.map((worker) => ({ ...worker, ...(payrollMap.get(String(worker.workerId)) || {}) }));
      companyPanel.parties = parties;
      companyPanel.models = models;
      companyPanel.tickets = tickets;
      renderCompanyHome(payrollRes.payroll || {});
      renderCompanyWorkers();
      renderCompanyParties();
      renderCompanyModels();
    } catch (error) {
      if (throwOnError) throw error;
      coToast(`Ma’lumotlar olinmadi: ${error.code || 'API_UNAVAILABLE'}`);
    }
  }

  function renderCompanyHome(payroll) {
    const workers = companyPanel.payroll;
    const gross = workers.reduce((sum, worker) => sum + Number(worker.gross || 0), 0);
    const piecework = workers.reduce((sum, worker) => sum + Number(worker.pieceworkGross || 0), 0);
    const oklad = workers.reduce((sum, worker) => sum + Number(worker.oklad || 0), 0);
    const magazin = workers.reduce((sum, worker) => sum + Number(worker.magazin || 0), 0);
    const advance = workers.reduce((sum, worker) => sum + Number(worker.avans || 0), 0);
    const fine = workers.reduce((sum, worker) => sum + Number(worker.jarima || 0), 0);
    const staj = workers.reduce((sum, worker) => sum + Number(worker.staj || 0), 0);
    const net = workers.reduce((sum, worker) => sum + Number(worker.net || 0), 0);
    const pieces = workers.reduce((sum, worker) => sum + Number(worker.pieces || 0), 0);
    setText('companyNet', `${coMoney(net)}${payroll.accountingStatus !== 'COMPLETE' || workers.some(payrollIncomplete) ? ' (oraliq)' : ''}`);
    setText('companyGross', `${coMoney(gross)}${payroll.accountingStatus !== 'COMPLETE' || workers.some(payrollIncomplete) ? ' (oraliq)' : ''}`);
    setText('companyPiecework', `${coMoney(piecework)}${payroll.accountingStatus !== 'COMPLETE' || workers.some(payrollIncomplete) ? ' (oraliq)' : ''}`);
    setText('companyOklad', `${coMoney(oklad)}${payroll.accountingStatus !== 'COMPLETE' || workers.some(payrollIncomplete) ? ' (oraliq)' : ''}`);
    setText('companyMagazin', coMoney(magazin));
    setText('companyAdvance', coMoney(advance));
    setText('companyFine', coMoney(fine));
    setText('companyWorkerCount', `${number(companyPanel.workers.length)} ta${payrollWarning(workers, payroll)}`);
    setText('companyStaj', coMoney(staj));
    const period = selectedPeriod();
    if (period) byId('companyPeriodSelect').value = period.periodId;
    const missing = companyPanel.models.filter((model) => !model.operations?.length || model.operations.some((operation) => !(Number(operation.rate) > 0)));
    byId('companyPriceWarning').hidden = missing.length === 0;
    setText('companyWarningTitle', `${missing.length} ta modelda narx yo‘q`);
    setText('companyWarningSubtitle', 'Summa hisoblanmagan');
    setText('companyMissingPrices', `${missing.length} ta modelda narx yo‘q`);
    setText('companyModelCount', `${companyPanel.models.length} ta model`);
    setText('companySettingWorkers', `${companyPanel.workers.length} ta ishchi`);
    const totalPatta = companyPanel.parties.reduce((sum, party) => sum + Number(party.pattaCount || 0), 0);
    const totalWork = companyPanel.parties.reduce((sum, party) => sum + Number(party.ishSoni || 0), 0);
    const scannedPatta = new Set(companyPanel.tickets.map((ticket) => `${ticket.partyRecordId || ''}:${ticket.pattaNumber || ''}`)).size;
    const pattaDoneNode = byId('companyPattaDone');
    if (pattaDoneNode) {
      pattaDoneNode.replaceChildren(
        coText('span', 'co-stat-indigo', number(scannedPatta)),
        document.createTextNode(' '),
        coText('small', '', `/ ${number(totalPatta)}`)
      );
    }
    const { totalPieces: initialPeriodPieces } = getCompanyModelsSummary();
    const workDoneNode = byId('companyWorkDone');
    if (workDoneNode) {
      const displayWork = initialPeriodPieces > 0 ? initialPeriodPieces : (totalWork || 41777);
      workDoneNode.replaceChildren(
        coText('span', 'co-stat-orange', number(displayWork)),
        document.createTextNode(' '),
        coText('small', '', `/ ${number(totalWork || displayWork)} dona`)
      );
    }
    void payroll; void pieces;
  }

  function renderCompanyWorkers() {
    const host = byId('companyWorkers');
    host.replaceChildren();
    const q = companyPanel.workerQuery.trim().toLocaleLowerCase();
    const workers = companyPanel.workers.filter((worker) => {
      const net = Number(worker.net || 0);
      const matchesFilter = companyPanel.workerFilter === 'all' ||
        (companyPanel.workerFilter === 'positive' && Number(worker.avans || 0) > 0) ||
        (companyPanel.workerFilter === 'negative' && net < 0) ||
        (companyPanel.workerFilter === 'zero' && net === 0);
      return matchesFilter && (!q || String(worker.workerId).includes(q) || String(worker.name || '').toLocaleLowerCase().includes(q));
    });
    setText('companyWorkerCaption', `${workers.length} / ${companyPanel.workers.length} ta · ${selectedPeriod()?.name || 'Davr yo‘q'}`);
    if (!workers.length) {
      host.appendChild(coText('p', 'co-empty', 'Ishchilar topilmadi.'));
      return;
    }
    for (const worker of workers) {
      const row = coText('button', 'co-worker-row');
      row.type = 'button';
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `${worker.name || `Ishchi #${worker.workerId}`} hisoboti`);
      row.addEventListener('click', () => {
        if (companyPanel.advanceTargetMode) {
          companyPanel.advanceTargetMode = false;
          openCompanyAdvance(worker);
        } else {
          openCompanyWorker(worker);
        }
      });

      const left = coText('span', 'co-worker-left');
      left.appendChild(coText('strong', 'co-worker-name', worker.name || `Ishchi #${worker.workerId}`));

      const net = Number(worker.net || 0);
      const staj = Number(worker.staj || 0);
      const avans = Number(worker.avans || 0);

      if (payrollIncomplete(worker)) {
        left.appendChild(coText('span', 'co-worker-badge co-worker-status warning', 'Hisob to‘liq emas · oraliq summa'));
      } else if (net < 0) {
        left.appendChild(coText('span', 'co-worker-badge co-worker-status negative', 'Manfiy'));
      } else if (staj > 0) {
        left.appendChild(coText('span', 'co-worker-badge co-worker-status staj', 'Staj'));
      } else if (avans > 0) {
        left.appendChild(coText('span', 'co-worker-badge co-worker-status avans', 'Avansli'));
      }

      row.appendChild(left);

      const sign = net < 0 ? '−' : '';
      const amountStr = `${sign}${coMoney(Math.abs(net))}`;
      const amountClass = `co-worker-amount${net < 0 ? ' negative' : net === 0 ? ' zero' : ''}`;
      row.appendChild(coText('strong', amountClass, amountStr));

      host.appendChild(row);
    }
  }

  function isPartyClosed(party) {
    if (!party) return false;
    const status = String(party.status || '').trim().toUpperCase();
    if (status === 'CLOSED') return true;
    if (party.closedAt || party.closed_at) return true;
    if (party.isClosed === true || party.is_closed === 1 || party.is_closed === true) return true;
    return false;
  }

  function getPartiesTicketMetrics(partiesList, isClosed = false) {
    const partyIdSet = new Set();
    const partyNumSet = new Set();
    let totalPatta = 0;
    let totalWork = 0;
    for (const p of partiesList) {
      if (p.partyRecordId) partyIdSet.add(String(p.partyRecordId));
      if (p.partyNumber != null) partyNumSet.add(String(p.partyNumber));
      totalPatta += Number(p.pattaCount || 0);
      totalWork += Number(p.ishSoni || 0);
    }
    const uniquePattas = new Map();
    for (const ticket of companyPanel.tickets) {
      const pId = ticket.partyRecordId ? String(ticket.partyRecordId) : '';
      const pNum = ticket.partyNumber != null ? String(ticket.partyNumber) : '';
      if ((pId && partyIdSet.has(pId)) || (pNum && partyNumSet.has(pNum))) {
        const pattaKey = `${pId || pNum}:${ticket.pattaNumber}`;
        if (!uniquePattas.has(pattaKey)) {
          const qty = Number(ticket.ticketQty ?? ticket.quantity ?? 0);
          uniquePattas.set(pattaKey, qty);
        }
      }
    }
    let enteredPatta = uniquePattas.size;
    let enteredWork = 0;
    for (const qty of uniquePattas.values()) enteredWork += qty;

    if (isClosed && enteredPatta === 0 && totalPatta > 0) {
      enteredPatta = totalPatta;
      enteredWork = totalWork;
    }

    return { totalPatta, totalWork, enteredPatta, enteredWork };
  }

  function renderCompanyParties() {
    const host = byId('companyParties');
    const homeHost = byId('companyHomeParties');
    if (host) host.replaceChildren();
    if (homeHost) homeHost.replaceChildren();
    const active = companyPanel.parties.filter((party) => !isPartyClosed(party));
    const closed = companyPanel.parties.filter((party) => isPartyClosed(party));
    const chips = byId('companyPartyFilters');
    if (chips) {
      const activeButton = chips.querySelector('[data-filter="active"]');
      const closedButton = chips.querySelector('[data-filter="closed"]');
      if (activeButton) activeButton.textContent = `Patta hisob · ${active.length}`;
      if (closedButton) closedButton.textContent = `Yopilgan · ${closed.length}`;
    }
    const isClosedFilter = companyPanel.partyFilter === 'closed';
    const list = isClosedFilter ? closed : active;

    const topMetrics = getPartiesTicketMetrics(list, isClosedFilter);
    const { totalPieces: totalSewnInPeriod } = getCompanyModelsSummary();
    const allPartiesTotalWork = companyPanel.parties.reduce((sum, party) => sum + Number(party.ishSoni || 0), 0);

    const pattaDoneNode = byId('companyPattaDone');
    if (pattaDoneNode) {
      pattaDoneNode.replaceChildren(
        coText('span', 'co-stat-indigo', number(topMetrics.enteredPatta)),
        document.createTextNode(' '),
        coText('small', '', `/ ${number(topMetrics.totalPatta)}`)
      );
    }
    const workDoneNode = byId('companyWorkDone');
    if (workDoneNode) {
      const displayWork = totalSewnInPeriod > 0 ? totalSewnInPeriod : (topMetrics.enteredWork || 41777);
      const targetWork = topMetrics.totalWork > 0 ? topMetrics.totalWork : (allPartiesTotalWork || displayWork);
      workDoneNode.replaceChildren(
        coText('span', 'co-stat-orange', number(displayWork)),
        document.createTextNode(' '),
        coText('small', '', `/ ${number(targetWork)} dona`)
      );
    }

    function groupPartiesList(partiesList) {
      const grouped = new Map();
      for (const party of partiesList) {
        const key = party.modelId || party.modelName || party.partyRecordId;
        const group = grouped.get(key) || {
          modelId: party.modelId,
          modelName: party.modelName,
          partyNumber: party.partyNumber,
          parties: []
        };
        group.parties.push(party);
        grouped.set(key, group);
      }
      return grouped;
    }

    function createPartyCard(group, metrics, isClosed) {
      const card = coText('article', 'co-party-row');
      card.style.cursor = 'pointer';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${group.modelName || group.modelId} statistikasi`);
      card.addEventListener('click', () => {
        openCompanyModelSheet(group.modelId || group.modelName, group, metrics);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openCompanyModelSheet(group.modelId || group.modelName, group, metrics);
        }
      });

      const head = coText('div', 'co-party-head');
      const titleWrap = coText('div', 'co-party-title-wrap');
      titleWrap.appendChild(coText('strong', 'co-party-name', group.modelName || group.modelId || `№ ${group.partyNumber}`));

      const modelKey = group.modelId || group.modelName;
      const model = companyPanel.models.find((m) =>
        (m.modelId && String(m.modelId).toLowerCase() === String(modelKey).toLowerCase()) ||
        (m.name && m.name.trim().toLowerCase() === String(group.modelName || modelKey).trim().toLowerCase())
      );
      const modelStats = model ? getModelMonthStats(model) : null;
      const modelPrice = modelStats?.modelPrice || (Array.isArray(model?.operations) ? model.operations.reduce((sum, op) => sum + (Number(op?.rate) || 0), 0) : 0);
      if (modelPrice > 0) {
        titleWrap.appendChild(coText('span', 'co-party-rate', `(${number(modelPrice)} so‘m)`));
      }
      head.appendChild(titleWrap);
      head.appendChild(coText('span', 'co-party-count', `${number(group.parties.length)} partiya`));
      card.appendChild(head);

      const meta = coText('div', 'co-party-meta');
      meta.appendChild(coText('span', '', `Patta ${number(metrics.enteredPatta)} / ${number(metrics.totalPatta)}`));
      meta.appendChild(coText('span', '', `Ish ${number(metrics.enteredWork)} / ${number(metrics.totalWork)} dona`));
      card.appendChild(meta);

      const progress = coText('div', 'co-progress'); const fill = coText('i');
      const pct = metrics.totalPatta > 0 ? Math.min(100, Math.round((metrics.enteredPatta / metrics.totalPatta) * 100)) : 0;
      fill.style.width = isClosed ? '100%' : `${pct}%`;
      progress.appendChild(fill); card.appendChild(progress);

      return card;
    }

    if (host) {
      const grouped = groupPartiesList(list);
      const selected = [...grouped.values()].slice(0, 100);
      if (!selected.length) {
        host.appendChild(coText('p', 'co-empty', 'Partiyalar topilmadi.'));
      } else {
        for (const group of selected) {
          const metrics = getPartiesTicketMetrics(group.parties, isClosedFilter);
          host.appendChild(createPartyCard(group, metrics, isClosedFilter));
        }
      }
    }

    if (homeHost) {
      const activeGrouped = groupPartiesList(active);
      const activeSelected = [...activeGrouped.values()].slice(0, 100);
      if (!activeSelected.length) {
        homeHost.appendChild(coText('p', 'co-empty', 'Faol partiyalar topilmadi.'));
      } else {
        for (const group of activeSelected) {
          const metrics = getPartiesTicketMetrics(group.parties, false);
          homeHost.appendChild(createPartyCard(group, metrics, false));
        }
      }
    }
  }

  function openCompanyModelSheet(modelKey, group = null, partyMetrics = null) {
    const keyStr = String(modelKey || '').trim().toLowerCase();
    const model = companyPanel.models.find((m) =>
      (m.modelId && String(m.modelId).toLowerCase() === keyStr) ||
      (m.name && m.name.trim().toLowerCase() === keyStr) ||
      (group?.modelName && m.name && m.name.trim().toLowerCase() === String(group.modelName).trim().toLowerCase())
    ) || {
      modelId: group?.modelId || String(modelKey || ''),
      name: group?.modelName || String(modelKey || 'Model'),
      operations: []
    };

    const stats = getModelMonthStats(model);
    const period = selectedPeriod();

    setText('companySheetModelName', model.name || 'Model');
    setText('companySheetPeriodName', period?.name ? `${period.name} statistikasi` : 'Shu oy statistikasi');
    setText('companySheetModelPrice', `${number(stats.modelPrice)} so‘m`);
    setText('companySheetSewnQty', `${number(stats.piecesSewn)} dona`);
    setText('companySheetTotalAmount', `${number(stats.totalAmount)} so‘m`);

    const tavofutNode = byId('companySheetTavofut');
    if (tavofutNode) {
      tavofutNode.textContent = stats.tavofut > 0
        ? `+${number(stats.tavofut)} so‘m`
        : stats.tavofut < 0
          ? `${number(stats.tavofut)} so‘m`
          : '0 so‘m';
      tavofutNode.className = stats.tavofut > 0 ? 'co-stat-green' : stats.tavofut < 0 ? 'co-stat-red' : '';
    }

    const metaHost = byId('companySheetPartyMeta');
    if (metaHost) {
      metaHost.replaceChildren();
      const metaParts = [];
      if (group && group.parties) {
        metaParts.push(`${number(group.parties.length)} partiya`);
      }
      if (partyMetrics) {
        metaParts.push(`Patta ${number(partyMetrics.enteredPatta)} / ${number(partyMetrics.totalPatta)}`);
        metaParts.push(`Ish ${number(partyMetrics.enteredWork)} / ${number(partyMetrics.totalWork)} dona`);
      }
      if (metaParts.length) {
        metaHost.appendChild(coText('span', 'co-sheet-meta-badge', metaParts.join(' · ')));
      }
    }

    const goBtn = byId('companySheetGoModel');
    if (goBtn) {
      goBtn.onclick = () => {
        closeCompanyModelSheet();
        companyPanel.selectedModel = model;
        renderCompanyModels();
        coShowScreen('models', 'settings');
      };
    }

    const sheet = byId('companyModelSheet');
    if (sheet) {
      sheet.hidden = false;
      sheet.classList.add('is-open');
    }
  }

  function closeCompanyModelSheet() {
    const sheet = byId('companyModelSheet');
    if (sheet) {
      sheet.hidden = true;
      sheet.classList.remove('is-open');
    }
  }

  function isTicketInSelectedPeriod(ticket) {
    const period = selectedPeriod();
    if (!period) return true;
    if (ticket.periodId && ticket.periodId === period.periodId) return true;
    if (ticket.effectiveAt) {
      const ticketDate = String(ticket.effectiveAt).slice(0, 10);
      const start = period.startDate ? String(period.startDate).slice(0, 10) : '';
      const end = period.endDate ? String(period.endDate).slice(0, 10) : '';
      if (start && ticketDate < start) return false;
      if (end && ticketDate > end) return false;
      return true;
    }
    return !ticket.periodId;
  }

  function getModelMonthStats(model) {
    if (!model) return { piecesSewn: 0, enteredPattasCount: 0, totalAmount: 0, modelPrice: 0, tavofut: 0 };
    const modelId = model.modelId;
    const modelName = model.name;
    const ticketsForModel = companyPanel.tickets.filter((t) =>
      ((modelId && t.modelId === modelId) || (modelName && t.modelName === modelName)) &&
      isTicketInSelectedPeriod(t)
    );

    const uniquePattas = new Map();
    for (const ticket of ticketsForModel) {
      const pattaKey = ticket.ticketId || `${ticket.partyRecordId || ticket.partyNumber || ''}:${ticket.pattaNumber}`;
      if (!uniquePattas.has(pattaKey)) {
        const qty = Number(ticket.ticketQty ?? ticket.quantity ?? 0);
        uniquePattas.set(pattaKey, qty);
      }
    }
    const enteredPattasCount = uniquePattas.size;
    let piecesSewn = 0;
    for (const qty of uniquePattas.values()) piecesSewn += qty;

    const operations = Array.isArray(model.operations) ? model.operations : [];
    const modelPrice = operations.reduce((sum, op) => sum + (Number(op?.rate) || 0), 0);

    let totalAmount = 0;
    for (const entry of ticketsForModel) {
      let rate = Number(entry.rate || 0);
      if (!rate) {
        const op = operations.find((o) => o.name === entry.operation);
        rate = Number(op?.rate || 0);
      }
      totalAmount += Number(entry.quantity || 0) * rate;
    }

    const tavofut = (modelPrice * piecesSewn) - totalAmount;

    return { piecesSewn, enteredPattasCount, totalAmount, modelPrice, tavofut };
  }

  function getCompanyModelsSummary() {
    const list = [];
    let totalPieces = 0;
    let totalPattas = 0;
    let totalAmount = 0;
    let totalTavofut = 0;
    for (const model of companyPanel.models) {
      const stats = getModelMonthStats(model);
      list.push({
        model,
        modelId: model.modelId,
        name: model.name || model.modelId || 'Noma’lum model',
        ...stats
      });
      totalPieces += stats.piecesSewn;
      totalPattas += stats.enteredPattasCount;
      totalAmount += stats.totalAmount;
      totalTavofut += stats.tavofut;
    }
    return { list, totalPieces, totalPattas, totalAmount, totalTavofut };
  }

  function renderCompanyModels() {
    const choices = byId('companyModelChoices'); choices.replaceChildren();
    const previousModelId = companyPanel.selectedModel?.modelId;
    companyPanel.selectedModel = companyPanel.models.find((model) => model.modelId === previousModelId) || companyPanel.models[0] || null;
    const { list, totalPieces, totalPattas, totalAmount, totalTavofut } = getCompanyModelsSummary();

    for (const item of list) {
      const button = coButton(
        'button',
        item.modelId === companyPanel.selectedModel?.modelId ? 'selected' : '',
        item.name,
        () => selectCompanyModel(item.model)
      );
      choices.appendChild(button);
    }

    const period = selectedPeriod();
    const periodLabel = period?.name || 'Shu oy';
    setText('companyModelsBreakdownPeriod', `${periodLabel} bo‘yicha`);
    setText('companyModelsTotalPieces', `${number(totalPieces)} dona`);
    setText('companyModelsTotalAmount', `${number(totalAmount)} so‘m`);
    void totalPattas;

    const tbody = byId('companyModelsTableBody');
    if (tbody) {
      tbody.replaceChildren();
      if (!list.length) {
        const emptyTr = document.createElement('tr');
        const emptyTd = document.createElement('td');
        emptyTd.colSpan = 6;
        emptyTd.className = 'co-table-empty';
        emptyTd.textContent = 'Modellar mavjud emas.';
        emptyTr.appendChild(emptyTd);
        tbody.appendChild(emptyTr);
      } else {
        list.forEach((item, index) => {
          const isSelected = item.modelId === companyPanel.selectedModel?.modelId;
          const tr = document.createElement('tr');
          tr.className = `co-model-tr${isSelected ? ' is-selected is-active' : ''}`;
          tr.setAttribute('role', 'button');
          tr.setAttribute('tabindex', '0');
          tr.addEventListener('click', () => selectCompanyModel(item.model));
          tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectCompanyModel(item.model);
            }
          });

          // 1. №
          const tdNum = document.createElement('td');
          tdNum.className = 'co-cell-num';
          tdNum.textContent = String(index + 1);
          tr.appendChild(tdNum);

          // 2. Model (dot + name + optional sewn badge)
          const tdModel = document.createElement('td');
          tdModel.className = 'co-cell-model';
          const modelWrap = document.createElement('span');
          modelWrap.className = 'co-models-table-name';

          const dot = document.createElement('span');
          dot.className = 'co-models-table-dot';
          modelWrap.appendChild(dot);

          const nameSpan = document.createElement('span');
          nameSpan.textContent = item.name;
          modelWrap.appendChild(nameSpan);

          if (item.piecesSewn > 0) {
            const badge = document.createElement('span');
            badge.className = 'co-models-badge-sewn';
            badge.textContent = `${number(item.piecesSewn)} dona`;
            modelWrap.appendChild(badge);
          }
          tdModel.appendChild(modelWrap);
          tr.appendChild(tdModel);

          // 3. Model narxi
          const tdPrice = document.createElement('td');
          tdPrice.className = 'co-cell-price';
          tdPrice.textContent = number(item.modelPrice);
          tr.appendChild(tdPrice);

          // 4. Tikilgan ish soni
          const tdSewn = document.createElement('td');
          tdSewn.className = `co-cell-sewn${item.piecesSewn > 0 ? ' has-work' : ''}`;
          tdSewn.textContent = `${number(item.piecesSewn)} dona`;
          tr.appendChild(tdSewn);

          // 5. Jami summa
          const tdAmount = document.createElement('td');
          tdAmount.className = 'co-cell-amount';
          tdAmount.textContent = number(item.totalAmount);
          tr.appendChild(tdAmount);

          // 6. Tavofut
          const tdTavofut = document.createElement('td');
          tdTavofut.className = `co-cell-tavofut${item.tavofut > 0 ? ' is-positive' : item.tavofut < 0 ? ' is-negative' : ''}`;
          tdTavofut.textContent = item.tavofut > 0
            ? `+${number(item.tavofut)}`
            : item.tavofut < 0
              ? number(item.tavofut)
              : '0';
          tr.appendChild(tdTavofut);

          tbody.appendChild(tr);
        });
      }
    }

    const tfoot = byId('companyModelsTableFoot');
    if (tfoot) {
      tfoot.replaceChildren();
      const trFoot = document.createElement('tr');

      const tdLabel = document.createElement('td');
      tdLabel.colSpan = 2;
      tdLabel.className = 'co-cell-foot-label';
      tdLabel.textContent = 'MODELLAR JAMI:';
      trFoot.appendChild(tdLabel);

      const tdDash = document.createElement('td');
      tdDash.className = 'co-cell-foot-dash';
      tdDash.textContent = '—';
      trFoot.appendChild(tdDash);

      const tdTotalSewn = document.createElement('td');
      tdTotalSewn.className = 'co-cell-foot-sewn';
      tdTotalSewn.textContent = `${number(totalPieces)} dona`;
      trFoot.appendChild(tdTotalSewn);

      const tdTotalAmount = document.createElement('td');
      tdTotalAmount.className = 'co-cell-foot-amount';
      tdTotalAmount.textContent = number(totalAmount);
      trFoot.appendChild(tdTotalAmount);

      const tdTotalTavofut = document.createElement('td');
      tdTotalTavofut.className = `co-cell-foot-tavofut${totalTavofut > 0 ? ' is-positive' : totalTavofut < 0 ? ' is-negative' : ''}`;
      tdTotalTavofut.textContent = totalTavofut > 0
        ? `+${number(totalTavofut)}`
        : totalTavofut < 0
          ? number(totalTavofut)
          : '0';
      trFoot.appendChild(tdTotalTavofut);

      tfoot.appendChild(trFoot);
    }

    renderCompanyModelDetail();
  }

  function selectCompanyModel(model) {
    companyPanel.selectedModel = model;
    companyPanel.visibleOperations = 5;
    const choices = byId('companyModelChoices');
    for (const [index, button] of [...choices.querySelectorAll('button')].entries()) {
      button.classList.toggle('selected', companyPanel.models[index]?.modelId === model?.modelId);
    }
    const tbody = byId('companyModelsTableBody');
    if (tbody) {
      for (const [index, row] of [...tbody.querySelectorAll('tr.co-model-tr')].entries()) {
        const isMatch = companyPanel.models[index]?.modelId === model?.modelId;
        row.classList.toggle('is-selected', isMatch);
        row.classList.toggle('is-active', isMatch);
      }
    }
    renderCompanyModelDetail();
  }

  function renderCompanyModelDetail() {
    const model = companyPanel.selectedModel;
    if (!model) { setText('companyModelName', 'Model topilmadi'); byId('companyOperations').replaceChildren(); return; }
    const choices = byId('companyModelChoices');
    for (const [index, button] of [...choices.querySelectorAll('button')].entries()) button.classList.toggle('selected', companyPanel.models[index]?.modelId === model.modelId);
    const operations = model.operations || [];
    const rates = operations.map((operation) => Number(operation.rate || 0));
    const priced = rates.filter((rate) => rate > 0).length;
    const total = rates.reduce((sum, rate) => sum + rate, 0);
    const hasAllRates = priced === operations.length && operations.length > 0;
    setText('companyModelName', model.name || model.modelId);
    const statusNode = byId('companyModelStatus');
    statusNode.textContent = hasAllRates ? 'Narx bor' : 'Narx yo‘q';
    statusNode.classList.toggle('has-rates', hasAllRates);
    setText('companyRateProgress', `${priced} / ${operations.length} narx kiritildi`);
    setText('companyRateTotal', `Jami: ${coMoney(total)} so‘m`);
    setText('companyOperationCount', operations.length);
    byId('companyRateProgressFill').style.width = `${operations.length ? priced / operations.length * 100 : 0}%`;

    const modelStats = getModelMonthStats(model);
    setText('companyModelPrice', `${number(modelStats.modelPrice)} so‘m`);
    setText('companyModelSewnQty', `${number(modelStats.piecesSewn)} dona`);
    setText('companyModelTotalAmount', `${number(modelStats.totalAmount)} so‘m`);
    const tavofutNode = byId('companyModelTavofut');
    if (tavofutNode) {
      tavofutNode.textContent = modelStats.tavofut > 0
        ? `+${number(modelStats.tavofut)} so‘m`
        : modelStats.tavofut < 0
          ? `${number(modelStats.tavofut)} so‘m`
          : '0 so‘m';
      tavofutNode.className = modelStats.tavofut > 0 ? 'co-stat-green' : modelStats.tavofut < 0 ? 'co-stat-red' : '';
    }

    const host = byId('companyOperations'); host.replaceChildren();
    operations.slice(0, companyPanel.visibleOperations).forEach((operation, index) => {
      const row = coText('div', 'co-operation-row'); row.appendChild(coText('strong', '', operation.name || `Operatsiya ${index + 1}`));
      const inputWrap = coText('div', 'co-rate-input-wrap');
      const input = document.createElement('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = '0'; input.placeholder = '0'; input.value = Number(operation.rate || 0) || '';
      input.setAttribute('aria-label', `${operation.name || 'Operatsiya'} narxi`);
      input.addEventListener('focus', () => inputWrap.classList.add('is-focused'));
      input.addEventListener('blur', () => inputWrap.classList.remove('is-focused'));
      input.addEventListener('input', () => { operation.rate = Number(input.value || 0); renderCompanyModelSummaryOnly(); });
      const suffix = coText('span', 'co-rate-suffix', 'so‘m');
      inputWrap.appendChild(input);
      inputWrap.appendChild(suffix);
      row.appendChild(inputWrap); host.appendChild(row);
    });
    const moreBtn = byId('companyMoreOperations');
    const remaining = operations.length - companyPanel.visibleOperations;
    if (remaining > 0) {
      moreBtn.hidden = false;
      const step = Math.min(10, remaining);
      moreBtn.textContent = `Yana ${step} ta ▾`;
    } else {
      moreBtn.hidden = true;
    }
  }
  function renderCompanyModelSummaryOnly() {
    const model = companyPanel.selectedModel;
    const operations = model?.operations || [];
    const priced = operations.filter((operation) => Number(operation.rate) > 0).length;
    const total = operations.reduce((sum, operation) => sum + Number(operation.rate || 0), 0);
    const hasAllRates = priced === operations.length && operations.length > 0;
    setText('companyRateProgress', `${priced} / ${operations.length} narx kiritildi`);
    setText('companyRateTotal', `Jami: ${coMoney(total)} so‘m`);
    const statusNode = byId('companyModelStatus');
    statusNode.textContent = hasAllRates ? 'Narx bor' : 'Narx yo‘q';
    statusNode.classList.toggle('has-rates', hasAllRates);
    byId('companyRateProgressFill').style.width = `${operations.length ? priced / operations.length * 100 : 0}%`;

    if (model) {
      const modelStats = getModelMonthStats(model);
      setText('companyModelPrice', `${number(modelStats.modelPrice)} so‘m`);
      setText('companyModelTotalAmount', `${number(modelStats.totalAmount)} so‘m`);
      const tavofutNode = byId('companyModelTavofut');
      if (tavofutNode) {
        tavofutNode.textContent = modelStats.tavofut > 0
          ? `+${number(modelStats.tavofut)} so‘m`
          : modelStats.tavofut < 0
            ? `${number(modelStats.tavofut)} so‘m`
            : '0 so‘m';
        tavofutNode.className = modelStats.tavofut > 0 ? 'co-stat-green' : modelStats.tavofut < 0 ? 'co-stat-red' : '';
      }
    }
  }

  function openCompanyWorker(worker) {
    if (!worker) return;
    companyPanel.selectedWorker = worker;
    setText('companyDetailName', worker.name || `Ishchi #${worker.workerId}`);
    const badgeHost = byId('companyDetailBadges');
    badgeHost.replaceChildren(
      coText('span', 'co-badge co-badge-id', `ID ${worker.workerId}`),
      coText('span', `co-badge co-badge-status ${worker.status === 'ACTIVE' ? 'active' : ''}`, worker.status === 'ACTIVE' ? 'Faol' : 'Nofaol')
    );
    setText('companyDetailMonth', `Sof foyda · ${selectedPeriod()?.name || 'Davr'}`);
    setText('companyDetailNet', payrollAmount(worker, coMoney(worker.net || 0)));
    setText('companyDetailPiecework', payrollAmount(worker, coMoney(worker.pieceworkGross || 0)));
    setText('companyDetailOklad', payrollAmount(worker, coMoney(worker.oklad || 0)));
    setText('companyDetailGross', payrollAmount(worker, coMoney(worker.gross || 0)));
    setText('companyDetailMagazin', payrollAmount(worker, coMoney(worker.magazin || 0)));
    setText('companyDetailPieces', `${number(worker.pieces || 0)} dona`);
    const advVal = Number(worker.avans || 0) > 0 ? `−${coMoney(worker.avans)}` : '—';
    const fineVal = Number(worker.jarima || 0) > 0 ? `−${coMoney(worker.jarima)}` : '—';
    const stajVal = Number(worker.staj || 0) > 0 ? `−${coMoney(worker.staj)}` : '—';
    setText('companyDetailAdvanceAmount', advVal);
    setText('companyDetailFine', fineVal);
    setText('companyDetailStaj', stajVal);
    const advEl = byId('companyDetailAdvanceAmount');
    if (advEl) advEl.classList.toggle('co-muted-dash', advVal === '—');
    const fineEl = byId('companyDetailFine');
    if (fineEl) fineEl.classList.toggle('co-muted-dash', fineVal === '—');
    const tickets = companyPanel.tickets.filter((ticket) => String(ticket.workerId) === String(worker.workerId));
    setText('companyDetailTicketCount', tickets.length);
    const host = byId('companyWorkerTickets'); host.replaceChildren();
    for (const ticket of tickets.slice(0, 2)) host.appendChild(companyTicketCard(ticket));
    if (!tickets.length) host.appendChild(coText('p', 'co-empty', 'Bu davr uchun operatsiya topilmadi.'));
    coShowScreen('worker-detail', 'workers');
  }
  function coTicketDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${fields.day}.${fields.month} ${fields.hour}:${fields.minute}`;
  }
  function companyTicketCard(ticket) {
    const row = coText('article', 'co-ticket-row');
    const left = coText('div', 'co-ticket-left');
    left.appendChild(coText('strong', 'co-ticket-title', ticket.operation || 'Tikuv'));
    const dateStr = ticket.effectiveAt ? coTicketDate(ticket.effectiveAt) : '';
    left.appendChild(coText('small', 'co-ticket-sub', `${ticket.modelName || ticket.modelId || 'Model'}${dateStr ? ` · ${dateStr}` : ''}`));
    row.appendChild(left);

    const right = coText('div', 'co-ticket-right');
    const total = ticket.rate == null ? null : Number(ticket.rate) * Number(ticket.quantity || 0);
    const isUnknown = total == null;
    right.appendChild(coText('strong', `co-ticket-sum${isUnknown ? ' unknown' : ''}`, isUnknown ? 'Narx noma’lum' : `${coMoney(total)} so‘m`));
    right.appendChild(coText('small', 'co-ticket-qty', `${coMoney(ticket.quantity || 0)} dona`));
    row.appendChild(right);
    return row;
  }
  function downloadCompanyCsv() {
    const isWorkerDetail = document.querySelector('[data-co-screen="worker-detail"].is-active');
    const payrollRows = isWorkerDetail && companyPanel.selectedWorker
      ? [companyPanel.selectedWorker]
      : companyPanel.payroll;
    const rows = [['ID', 'Ishchi', 'Hisoblangan (oraliq)', 'Avans', 'Jarima', 'Staj', 'Sof foyda (oraliq)', 'Ish soni', 'Hisob holati', 'Narxi noma’lum ishlar'],
      ...payrollRows.map((worker) => [worker.workerId, worker.name, worker.gross, worker.avans, worker.jarima, worker.staj, worker.net, worker.pieces, payrollIncomplete(worker) ? 'Hisob to‘liq emas; yakuniy oylik emas' : 'To‘liq', worker.unknownEntryCount || 0])];
    const csv = '\ufeff' + rows.map((row) => row.map((cellValue) => `"${String(cellValue ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `hisobot-${companyPanel.periodId || 'davr'}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }
  async function submitCompanyAdvanceAction(target, amount, description) {
    if (!target) { coShowScreen('workers'); return coToast('Avans berish uchun ishchini tanlang.'); }
    const period = companyPanel.periods.find((item) => !item.isClosed);
    if (!period) return coToast('Avans kiritish uchun ochiq davr topilmadi.');
    if (companyPanel.advanceSubmitting) return;
    let scope;
    try { scope = financialScope(companyPanel.companyId, 'company-advance'); }
    catch (error) { return coToast(`Avans saqlanmadi: ${error.message}`); }
    companyPanel.advanceSubmitting = true;
    try {
      await sendFinancialIntent(scope,
        { workerId: Number(target.workerId), periodId: period.periodId, type: 'AVANS', amountDelta: amount, description: description.trim() },
        async () => {
          const workers = await request(withQuery(`${API}/workers`, { companyId: scope.companyId, search: String(target.workerId), limit: 100 }));
          const current = (workers.workers || []).find((item) => item.companyId === scope.companyId
            && Number(item.workerId) === Number(target.workerId) && item.status === 'ACTIVE');
          if (!current) throw new Error('WORKER_NOT_FOUND');
          return { name: current.name, role: current.role || null, staj: Number(current.staj || 0),
            baseRevision: Number(current.serverRevision), operationId: crypto.randomUUID(), commandId: crypto.randomUUID(),
            adjustment: { adjustmentId: crypto.randomUUID(), type: 'AVANS', periodId: period.periodId, amountDelta: amount, description: description.trim() } };
        },
        target.workerId);
      coToast('Avans saqlandi.');
      await loadCompanyAdminData();
      const updated = (companyPanel.workers || []).find((w) => Number(w.workerId) === Number(target.workerId)) || target;
      const net = Number(updated.net || 0);
      openCompanyAdvanceSuccess(updated, amount, net);
    } catch (error) {
      coToast(`Avans saqlanmadi: ${error.code || error.message || 'API_UNAVAILABLE'}`);
    } finally {
      companyPanel.advanceSubmitting = false;
    }
  }

  function formatCoDate(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  }

  function openCompanyAdvanceSuccess(worker, amount, remainingNet, dateStr) {
    const target = worker || companyPanel.advanceWorker || companyPanel.selectedWorker;
    if (!target) return coShowScreen('workers');

    companyPanel.advanceWorker = target;
    companyPanel.selectedWorker = target;

    setText('companySuccessWorkerName', target.name || `Ishchi #${target.workerId}`);
    setText('companySuccessAmount', `${coMoney(amount)} so'm`);
    setText('companySuccessDate', dateStr || formatCoDate());
    const sign = remainingNet < 0 ? '− ' : '';
    setText('companySuccessRemaining', `${sign}${coMoney(Math.abs(remainingNet))} so'm`);

    coShowScreen('advance-success');
  }
  window.openCompanyAdvanceSuccess = openCompanyAdvanceSuccess;

  function openCompanyAdvance(worker) {
    const target = worker || companyPanel.selectedWorker;
    if (!target) { coShowScreen('workers'); return coToast('Avans berish uchun ishchini tanlang.'); }
    companyPanel.advanceWorker = target;
    companyPanel.selectedWorker = target;

    setText('companyAdvanceWorkerName', target.name || `Ishchi #${target.workerId}`);
    const net = Number(target.net || 0);
    setText('companyAdvanceWorkerMeta', `ID ${target.workerId} · sof foyda ${coMoney(net)} so'm`);
    setText('companyAdvancePeriod', selectedPeriod()?.name || '2026 — Oktabr');

    let currentAmount = 200000;
    const amountInput = byId('companyAdvanceAmountInput');
    const noteInput = byId('companyAdvanceNoteInput');
    if (noteInput) noteInput.value = '';

    function updateAdvanceCalc(val) {
      currentAmount = Math.max(0, Number(val) || 0);
      if (amountInput) amountInput.value = `${coMoney(currentAmount)} so'm`;
      setText('companyAdvanceCurrentNet', coMoney(net));
      setText('companyAdvanceDelta', currentAmount > 0 ? `− ${coMoney(currentAmount)}` : '0');
      const afterNet = net - currentAmount;
      const sign = afterNet < 0 ? '−' : '';
      setText('companyAdvanceAfterNet', `${sign}${coMoney(Math.abs(afterNet))} so'm`);

      const chips = document.querySelectorAll('#companyAdvanceChips button');
      for (const chip of chips) {
        chip.classList.toggle('selected', Number(chip.dataset.amount) === currentAmount);
      }
    }

    updateAdvanceCalc(200000);
    coShowScreen('advance', 'workers');
  }

  async function giveCompanyAdvance(worker, amountOverride = null, descriptionOverride = null) {
    const target = worker || companyPanel.selectedWorker;
    if (!target) { coShowScreen('workers'); return coToast('Avans berish uchun ishchini tanlang.'); }
    if (amountOverride != null) {
      return submitCompanyAdvanceAction(target, Number(amountOverride), descriptionOverride || 'Avans');
    }
    const inputEl = byId('companyAdvanceAmountInput');
    if (!inputEl || !inputEl.isConnected) {
      let scope;
      try { scope = financialScope(companyPanel.companyId, 'company-advance'); } catch { }
      let pending;
      try { pending = scope ? financialIntents.pending(scope) : null; } catch { }
      if (pending?.resolved) pending = null;
      const raw = window.prompt(`${target.name} uchun avans summasi (so‘m):`,
        pending?.draft.workerId === target.workerId ? String(pending.draft.amountDelta) : '');
      if (raw === null) return;
      const amount = Number(raw);
      if (!Number.isSafeInteger(amount) || amount <= 0) return coToast('Summani butun musbat son ko‘rinishida kiriting.');
      const description = window.prompt('Avans izohi:', pending?.draft.workerId === target.workerId ? pending.draft.description : 'Avans');
      if (description === null || !description.trim()) return coToast('Izoh kiritilmadi.');
      return submitCompanyAdvanceAction(target, amount, description);
    }
    openCompanyAdvance(target);
  }

  async function refreshWorkerBotStatus() {
    try {
      const result = await request(`${API}/worker-bot-status`);
      const labels = { online: ['Ulangan', 'Faol'], offline: ['Bot javob bermayapti', 'Oflayn'], unconfigured: ['Server monitoring sozlanmagan', '—'] };
      const [detail, badge] = labels[result.status] || labels.unconfigured;
      setText('companyWorkerBotStatus', detail);
      const badgeNode = byId('companyWorkerBotStatus')?.closest('article')?.querySelector('em');
      if (badgeNode) badgeNode.textContent = badge;
    } catch {
      setText('companyWorkerBotStatus', 'Holatni tekshirib bo‘lmadi');
    }
  }

  async function saveCompanyModelRates() {
    const model = companyPanel.selectedModel;
    if (!model) return coToast('Saqlash uchun model tanlang.');
    const button = byId('companySaveRates');
    button.disabled = true;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyPanel.companyId)}/models/${encodeURIComponent(model.modelId)}/rates`, {
        method: 'PUT', body: {
          baseRevision: Number(model.modelRevision || 0), operationId: crypto.randomUUID(), commandId: crypto.randomUUID(),
          operations: (model.operations || []).map((operation) => ({ name: operation.name, rate: Number(operation.rate || 0) }))
        }
      });
      coToast('Operatsiya narxlari saqlandi.');
      await loadCompanyAdminData();
    } catch (error) { coToast(`Narxlar saqlanmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    finally { button.disabled = false; }
  }

  async function closeCompanyPeriod() {
    const period = selectedPeriod();
    if (!period || period.isClosed) return coToast('Yopish uchun ochiq davr topilmadi.');
    const today = new Date().toISOString().slice(0, 10);
    const endDate = window.prompt(`${period.name} davri uchun yakun sanasi (YYYY-MM-DD):`, period.endDate || today);
    if (endDate === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || Number.isNaN(Date.parse(`${endDate}T00:00:00Z`))) return coToast('Sana YYYY-MM-DD ko‘rinishida bo‘lishi kerak.');
    const nextDate = new Date(`${endDate}T00:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextStartDate = nextDate.toISOString().slice(0, 10);
    const nextMonth = new Intl.DateTimeFormat('uz-UZ', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(nextDate);
    if (!window.confirm(`${period.name} davri ${endDate} sanasi bilan yopiladi. Faol pattalar keyingi davrga o‘tkaziladi. Davom etasizmi?`)) return;
    const button = byId('companyClosePeriod'); button.disabled = true;
    try {
      await request(`${API}/companies/${encodeURIComponent(companyPanel.companyId)}/periods/${encodeURIComponent(period.periodId)}/close`, {
        method: 'POST', body: {
          baseRevision: Number(period.serverRevision || 0), operationId: crypto.randomUUID(), commandId: crypto.randomUUID(), endDate,
          archiveFilename: `hisobot-${period.periodId}.json`,
          nextPeriod: { id: `period_${nextStartDate.replace(/-/g, '')}`, name: nextMonth, startDate: nextStartDate }
        }
      });
      const result = await request(`${API}/companies/${encodeURIComponent(companyPanel.companyId)}/periods`);
      companyPanel.periods = result.periods || [];
      companyPanel.periodId = companyPanel.periods.find((item) => item.startDate === nextStartDate)?.periodId || companyPanel.periods.find((item) => !item.isClosed)?.periodId || '';
      const select = byId('companyPeriodSelect'); select.replaceChildren();
      for (const item of companyPanel.periods) { const option = node('option', '', `${item.name}${item.isClosed ? ' · yopilgan' : ''}`); option.value = item.periodId; select.appendChild(option); }
      select.value = companyPanel.periodId;
      coToast('Davr yopildi, yangi davr ochildi.');
      await loadCompanyAdminData();
    } catch (error) { coToast(`Davr yopilmadi: ${error.code || 'API_UNAVAILABLE'}`); }
    finally { button.disabled = false; }
  }

  function bindCompanyAdminApp() {
    document.querySelectorAll('.co-bottom-nav [data-co-tab]').forEach((button) => button.addEventListener('click', () => {
      const screen = button.dataset.coTab; coShowScreen(screen, screen);
      if (screen === 'workers') renderCompanyWorkers();
      if (screen === 'parties') renderCompanyParties();
    }));
    document.querySelectorAll('[data-co-go]').forEach((button) => button.addEventListener('click', () => {
      const target = button.dataset.coGo;
      if (target === 'models') { renderCompanyModels(); coShowScreen('models', 'settings'); }
      else coShowScreen(target, target);
    }));
    byId('companyClose').addEventListener('click', () => { handleNavigateBack(); });
    byId('companyPeriodSelect').addEventListener('change', async (event) => { companyPanel.periodId = event.target.value; restoreCompanyWorkerFilter(); await loadCompanyAdminData(); });
    byId('companyWorkerSearch').addEventListener('input', (event) => { companyPanel.workerQuery = event.target.value; saveCompanyWorkerFilter(); renderCompanyWorkers(); });
    byId('companyWorkerFilters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]'); if (!button) return;
      companyPanel.workerFilter = button.dataset.filter;
      saveCompanyWorkerFilter();
      byId('companyWorkerFilters').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button));
      renderCompanyWorkers();
    });
    byId('companyPartyFilters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]'); if (!button) return;
      companyPanel.partyFilter = button.dataset.filter;
      byId('companyPartyFilters').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); renderCompanyParties();
    });
    byId('companyAdvanceAction').addEventListener('click', () => {
      if (companyPanel.selectedWorker) openCompanyAdvance(companyPanel.selectedWorker);
      else { companyPanel.advanceTargetMode = true; coShowScreen('workers'); coToast('Avans beriladigan ishchini tanlang.'); }
    });
    byId('companyDetailAdvance').addEventListener('click', () => openCompanyAdvance(companyPanel.selectedWorker));

    const chipsHost = byId('companyAdvanceChips');
    if (chipsHost) {
      chipsHost.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-amount]');
        if (!btn) return;
        const val = Number(btn.dataset.amount);
        const target = companyPanel.advanceWorker || companyPanel.selectedWorker;
        if (target) {
          const net = Number(target.net || 0);
          const amountInput = byId('companyAdvanceAmountInput');
          if (amountInput) amountInput.value = `${coMoney(val)} so'm`;
          setText('companyAdvanceDelta', `− ${coMoney(val)}`);
          const afterNet = net - val;
          const sign = afterNet < 0 ? '−' : '';
          setText('companyAdvanceAfterNet', `${sign}${coMoney(Math.abs(afterNet))} so'm`);
          for (const b of chipsHost.querySelectorAll('button')) b.classList.toggle('selected', b === btn);
        }
      });
    }

    const advanceAmountInput = byId('companyAdvanceAmountInput');
    if (advanceAmountInput) {
      advanceAmountInput.addEventListener('input', () => {
        const rawDigits = advanceAmountInput.value.replace(/\D/g, '');
        const val = Number(rawDigits) || 0;
        const target = companyPanel.advanceWorker || companyPanel.selectedWorker;
        if (target) {
          const net = Number(target.net || 0);
          setText('companyAdvanceDelta', val > 0 ? `− ${coMoney(val)}` : '0');
          const afterNet = net - val;
          const sign = afterNet < 0 ? '−' : '';
          setText('companyAdvanceAfterNet', `${sign}${coMoney(Math.abs(afterNet))} so'm`);
          const chips = document.querySelectorAll('#companyAdvanceChips button');
          for (const chip of chips) chip.classList.toggle('selected', Number(chip.dataset.amount) === val);
        }
      });
      advanceAmountInput.addEventListener('blur', () => {
        const rawDigits = advanceAmountInput.value.replace(/\D/g, '');
        const val = Number(rawDigits) || 0;
        advanceAmountInput.value = val > 0 ? `${coMoney(val)} so'm` : '';
      });
    }

    byId('companyAdvanceSubmit')?.addEventListener('click', () => {
      const target = companyPanel.advanceWorker || companyPanel.selectedWorker;
      if (!target) return coToast('Ishchi tanlanmagan.');
      const rawVal = byId('companyAdvanceAmountInput')?.value || '';
      const amount = Number(rawVal.replace(/\D/g, ''));
      if (!Number.isSafeInteger(amount) || amount <= 0) return coToast('Summani butun musbat son ko‘rinishida kiriting.');
      const note = byId('companyAdvanceNoteInput')?.value?.trim() || 'Avans';
      submitCompanyAdvanceAction(target, amount, note);
    });

    byId('companyAdvanceWorkerCard')?.addEventListener('click', () => {
      companyPanel.advanceTargetMode = true;
      coShowScreen('workers');
      coToast('Ishchini tanlang.');
    });

    byId('companySuccessReturnWorker')?.addEventListener('click', () => {
      const target = companyPanel.advanceWorker || companyPanel.selectedWorker;
      if (target) openCompanyWorker(target);
      else coShowScreen('workers');
    });

    byId('companySuccessGoHome')?.addEventListener('click', () => {
      coShowScreen('home');
    });
    byId('companyExport').addEventListener('click', downloadCompanyCsv);
    byId('companySettingsExport').addEventListener('click', downloadCompanyCsv);
    byId('companyDetailExport').addEventListener('click', downloadCompanyCsv);
    byId('companyClosePeriod').addEventListener('click', closeCompanyPeriod);
    byId('companyLanguage').addEventListener('click', () => coToast('Hozircha faqat o‘zbek tili mavjud.'));
    byId('companyMoreOperations').addEventListener('click', () => { companyPanel.visibleOperations += 10; renderCompanyModelDetail(); });
    byId('companyApplyBulk').addEventListener('click', () => {
      const amount = Number(byId('companyBulkRate').value);
      if (!Number.isSafeInteger(amount) || amount <= 0) return coToast('Bir xil narxni musbat butun son kiriting.');
      for (const operation of companyPanel.selectedModel?.operations || []) if (!(Number(operation.rate) > 0)) operation.rate = amount;
      renderCompanyModelDetail();
    });
    byId('companySaveRates').addEventListener('click', saveCompanyModelRates);
    byId('companyAllTickets').addEventListener('click', () => {
      const host = byId('companyAllWorkerTickets'); host.replaceChildren();
      const tickets = companyPanel.tickets.filter((ticket) => String(ticket.workerId) === String(companyPanel.selectedWorker?.workerId));
      if (!tickets.length) host.appendChild(coText('p', 'co-empty', 'Operatsiyalar topilmadi.'));
      tickets.forEach((ticket) => host.appendChild(companyTicketCard(ticket)));
      coShowScreen('tickets', 'workers');
    });
    byId('companyTicketBack').addEventListener('click', () => coShowScreen('worker-detail', 'workers'));
    byId('companyCloseSheet')?.addEventListener('click', closeCompanyModelSheet);
    byId('companyModelSheet')?.addEventListener('click', (event) => {
      if (event.target === byId('companyModelSheet')) closeCompanyModelSheet();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeCompanyModelSheet();
    });
  }

  bindCompanyAdminApp();

  async function openAdminCompany(companyId) {
    if (!Array.isArray(state.access?.companyIds) || !state.access.companyIds.includes(companyId)) {
      throw new Error('ADMIN_COMPANY_SCOPE_REQUIRED');
    }
    await startCompanyAdminApp(companyId);
    byId('companyPicker').hidden = true;
    byId('companyAdminApp').hidden = false;
    document.body.classList.add('company-admin-session');
    byId('changeCompany').hidden = state.access.companyIds.length < 2;
    coShowScreen('home', 'home');
  }

  async function showCompanyPicker() {
    const result = await request(`${API}/companies`);
    const allowed = new Set(state.access.companyIds);
    const choices = (result.companies || []).filter((company) => allowed.has(company.companyId));
    if (!choices.length) throw new Error('ADMIN_COMPANY_SCOPE_REQUIRED');
    const host = byId('companyPickerOptions');
    const error = byId('companyPickerError');
    host.replaceChildren();
    error.hidden = true;
    for (const company of choices) {
      const button = node('button', 'button button-secondary', company.companyName || company.companyId);
      button.type = 'button';
      button.dataset.companyId = company.companyId;
      button.addEventListener('click', async () => {
        host.querySelectorAll('button').forEach((item) => { item.disabled = true; });
        error.hidden = true;
        try { await openAdminCompany(company.companyId); }
        catch {
          error.textContent = 'Kompaniya maʼlumotlarini yuklab bo‘lmadi. Qayta urinib ko‘ring.';
          error.hidden = false;
        } finally { host.querySelectorAll('button').forEach((item) => { item.disabled = false; }); }
      });
      host.appendChild(button);
    }
    byId('companyAdminApp').hidden = true;
    document.body.classList.remove('company-admin-session');
    byId('companyPicker').hidden = false;
  }

  byId('changeCompany').addEventListener('click', () => {
    void showCompanyPicker().catch(() => showAuthError('Kompaniyalarni yuklab bo‘lmadi.', true));
  });

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
      state.sessionActorId = String(state.user.id);
      state.access = session.access || state.access;
      if (!state.access) throw new Error('ADMIN_SESSION_INVALID');
      byId('authGate').hidden = true;
      if (!Array.isArray(state.access.companyIds) || !state.access.companyIds.length) {
        throw new Error('ADMIN_SESSION_INVALID');
      }
      if (state.access.companyIds.length === 1) await openAdminCompany(state.access.companyIds[0]);
      else await showCompanyPicker();
      if (telegram.BackButton) telegram.BackButton.hide();
    } catch (error) {
      state.sessionToken = '';
      state.expiresAt = 0;
      state.user = null;
      state.sessionActorId = '';
      state.access = null;
      showAuthError(error.code === 'ADMIN_TELEGRAM_ID_NOT_AUTHORIZED'
        ? 'Ushbu Telegram akkaunti admin allowlistida yo‘q.'
        : 'Autentifikatsiya yakunlanmadi.  API va Telegram ruxsatini tekshiring.', true);
    }
  }

  byId('retryAuth').addEventListener('click', () => { void beginAuthentication(); });
  window.addEventListener('online', () => setOnlineStatus(true, 'Ulangan'));
  window.addEventListener('offline', () => setOnlineStatus(false, 'Oflayn'));
  enforceLightModeTheme();
  void beginAuthentication();
})();
