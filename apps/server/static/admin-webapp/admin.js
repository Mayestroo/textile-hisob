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
    companies: [],
    activations: [],
    workers: [],
    companyAdmins: [],
    workerOffset: 0,
    workerFilters: {},
    bindingOffset: 0,
    activationSubmitting: false,
    workerSubmitting: false,
    viewLoaders: new Map()
  };

  const byId = (id) => document.getElementById(id);

  function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value == null ? '' : String(value);
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  }

  function cell(row, value, className) {
    const td = node('td', className, value);
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
      try { telegram?.HapticFeedback?.notificationOccurred?.('error'); } catch {}
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
    try { telegram?.HapticFeedback?.notificationOccurred?.('success'); } catch {}
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
      const error = new Error('API_UNAVAILABLE');
      error.code = 'API_UNAVAILABLE';
      throw error;
    }
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
    const [overviewResult, activationResult] = await Promise.all([
      request(`${API}/overview`),
      request(withQuery(`${API}/activations`, { status: 'PENDING', limit: 8 }))
    ]);
    const summary = overviewResult.overview;
    setText('metricCompanies', number(summary.companies));
    setText('metricWorkers', number(summary.workers));
    setText('metricModels', number(summary.models));
    setText('metricParties', number(summary.parties));
    setText('metricDevices', number(summary.devices));
    setText('metricPending', number(summary.pendingActivations));
    setText('metricBindings', number(summary.workerBindings));
    setText('recentSyncAt', summary.recentSyncAt ? timestamp(summary.recentSyncAt) : 'Hali mavjud emas');
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

  async function loadDevices() {
    const result = await request(`${API}/devices`);
    const registered = result.devices.registered || [];
    const registeredBody = tableMessage('registeredDeviceRows', 'registeredDeviceEmpty', registered);
    for (const item of registered) {
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
    byId('companyAdminManagement').hidden = !state.access?.isGlobalAdmin;
    const tbody = tableMessage('companyRows', 'companyEmpty', state.companies);
    for (const company of state.companies) {
      const row = node('tr');
      cell(row, company.companyId, 'mono');
      cell(row, company.companyName);
      cell(row, number(company.workerCount));
      cell(row, number(company.modelCount));
      cell(row, number(company.partyCount));
      cell(row, (company.availableSizes || []).join(', ') || '—');
      cell(row, company.serverRevision ?? '—');
      const configured = node('td');
      configured.appendChild(statusBadge(!company.activationConfigured ? 'UNCONFIGURED' : company.activationActive ? 'ACTIVE' : 'INACTIVE'));
      row.appendChild(configured);
      cell(row, company.allowedRoles?.length ? company.allowedRoles.join(', ') : '—');
      cell(row, company.requireTicketValidation == null ? '—' : company.requireTicketValidation ? 'Talab qilinadi' : 'Ixtiyoriy');
      const actionCell = node('td');
      if (company.businessScopeExists) {
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
    const workerRangeStart = result.total ? result.offset + 1 : 0;
    setText('workerCount', `${number(result.total)} ta · ${number(workerRangeStart)}–${number(Math.min(result.offset + workers.length, result.total))}`);
    setText('workerPage', `${number(workerRangeStart)}–${number(Math.min(result.offset + workers.length, result.total))} / ${number(result.total)}`);
    byId('workerPrevious').disabled = result.offset === 0;
    byId('workerNext').disabled = result.offset + workers.length >= result.total;
    const tbody = tableMessage('workerRows', 'workerEmpty', workers);
    for (const worker of workers) {
      const row = node('tr');
      cell(row, `#${worker.workerId}`, 'mono');
      cell(row, worker.name);
      cell(row, worker.companyId, 'mono');
      const status = node('td'); status.appendChild(statusBadge(worker.status)); row.appendChild(status);
      cell(row, money(worker.staj));
      cell(row, worker.binding ? `${worker.binding.username ? `@${worker.binding.username} · ` : ''}${worker.binding.telegramId}` : 'Bog‘lanmagan', 'mono');
      const actionCell = node('td');
      actionCell.className = 'actions-cell';
      const edit = node('button', 'small-action button-accent-action', 'Tahrirlash');
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
      : 'Davr topilmadi; saqlangan  faktlari bo‘yicha ko‘rinish.');
    const workers = payroll.workers || [];
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
    if (workers.length === 0) byId('payrollEmpty').textContent = 'PostgreSQL’da davr yoki ish haqi faktlari yo‘q.';
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
      actionCell.appendChild(node('span', item.signedActivation ? 'signature-state is-signed' : 'signature-state', item.signedActivation ? 'Ed25519 ✓' : '—'));
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
    const body = tableMessage('modelRows', 'modelEmpty', rows, 'Model yozuvlari topilmadi.');
    for (const item of rows) {
      const row = node('tr');
      cell(row, item.companyId, 'mono'); cell(row, item.modelId, 'mono'); cell(row, item.name);
      cell(row, (item.operations || []).map((operation) => `${operation.name || '—'}: ${operation.rate ?? '—'}`).join(', ') || '—');
      cell(row, (item.availableSizes || []).join(', ') || '—'); cell(row, item.serverRevision ?? '—'); body.appendChild(row);
    }
  }

  async function loadParties() {
    const result = await request(`${API}/parties`);
    const rows = result.parties || [];
    const body = tableMessage('partyRows', 'partyEmpty', rows, 'Partiya yozuvlari topilmadi.');
    for (const item of rows) {
      const row = node('tr'); cell(row, item.partyRecordId, 'mono'); cell(row, item.partyNumber);
      cell(row, item.companyId, 'mono'); cell(row, `${item.modelName || '—'} · ${item.modelId || ''}`);
      const status = node('td'); status.appendChild(statusBadge(item.status)); row.appendChild(status);
      cell(row, number(item.pattaCount)); cell(row, number(item.ishSoni)); cell(row, timestamp(item.updatedAt)); body.appendChild(row);
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
  }

  async function loadBalances() {
    const select = byId('balanceCompanySelect');
    const companyId = select?.value || state.companies.find((item) => item.businessScopeExists)?.companyId;
    if (!companyId) { tableMessage('balanceRows', 'balanceEmpty', [], 'Mavjud biznes scope topilmadi.'); return; }
    if (select && select.value !== companyId) {
      select.value = companyId;
    }
    const result = await request(withQuery(`${API}/balances`, { companyId }));
    const rows = result.facts || [];
    const body = tableMessage('balanceRows', 'balanceEmpty', rows, 'Balans faktlari topilmadi.');
    for (const item of rows) {
      const row = node('tr'); cell(row, `#${item.workerId}`); cell(row, item.workerName);
      cell(row, item.type === 'AVANS' ? 'Avans' : 'Jarima'); cell(row, money(item.total));
      cell(row, number(item.factCount)); cell(row, number(item.openingFactCount)); body.appendChild(row);
    }
  }

  async function loadSystem() {
    const { system } = await request(`${API}/system`);
    setText('systemApi', system.api); setText('systemDatabase', system.database);
    setText('systemMigration', system.migrationLevel ?? '—'); setText('systemRevision', system.serverRevision ?? '—');
    setText('systemChecked', timestamp(system.checkedAt)); setText('systemExternal', 'Bot va backup holati API’da yo‘q');
  }

  const loaders = {
    overview: loadOverview,
    devices: loadDevices,
    companies: loadCompanies,
    workers: () => loadWorkers(state.workerFilters),
    bindings: loadBindings,
    activations: loadActivations,
    admin: loadAdminView,
    models: loadModels, parties: loadParties, tickets: loadTickets,
    balances: async () => { if (!state.companies.length) await loadCompanies(); await loadBalances(); },
    system: loadSystem,
    more: async () => {}
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
      setNotice(`Ma’lumot olinmadi: ${error.code || 'API_UNAVAILABLE'}. PostgreSQL holatini tekshirib, qayta urinib ko‘ring.`, 'error');
    }
  }

  function handleNavigateBack() {
    const dialog = byId('workerDialog');
    if (dialog && dialog.open) {
      dialog.close();
      return;
    }
    try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch {}
    const fromMoreViews = ['companies', 'devices', 'models', 'parties', 'tickets', 'balances', 'system', 'admin'];
    if (fromMoreViews.includes(state.currentView)) {
      showView('more');
    } else {
      showView('overview');
    }
  }

  function showView(view) {
    if (!Object.hasOwn(loaders, view)) return;
    if (state.access?.isGlobalAdmin === false && view === 'system') return;
    state.currentView = view;
    for (const section of document.querySelectorAll('[data-section]')) {
      const visible = section.dataset.section === view;
      section.hidden = !visible;
      section.classList.toggle('is-visible', visible);
    }
    const primaryMobileViews = ['overview', 'workers', 'bindings', 'activations'];
    for (const button of document.querySelectorAll('.nav-button')) {
      const active = button.dataset.view === view || (button.dataset.view === 'more' && !primaryMobileViews.includes(view));
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    const labels = {
      overview: 'Umumiy ko‘rinish', devices: 'Qurilmalar', companies: 'Korxonalar',
      workers: 'Ishchilar va hisob-kitob', bindings: 'Bog‘lanishlar', models: 'Modellar', parties: 'Partiyalar', tickets: 'Ishlab chiqarish',
      balances: 'Avans va jarima', activations: 'Kalitlar & aktivatsiya', system: 'Tizim holati',
      admin: 'Admin sessiyasi', more: 'Yana'
    };
    setText('currentViewLabel', labels[view]);
    setText('mobileViewTitle', labels[view]);
    const isOverview = view === 'overview';
    const mobileBack = byId('mobileBackButton');
    if (mobileBack) mobileBack.hidden = isOverview;
    const mobileTitle = byId('mobileViewTitle');
    if (mobileTitle) mobileTitle.hidden = isOverview;
    if (telegram?.BackButton) {
      if (isOverview) telegram.BackButton.hide();
      else telegram.BackButton.show();
    }
    if (typeof window !== 'undefined' && window.scrollTo) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    void loadCurrentView();
  }

  async function beginAuthentication() {
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
        telegram.setHeaderColor?.('#171526');
        telegram.setBackgroundColor?.('#171526');
        if (telegram.BackButton) {
          telegram.BackButton.onClick(() => { handleNavigateBack(); });
        }
      } catch {}
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
      for (const button of document.querySelectorAll('.nav-button[data-view]')) {
        button.hidden = !state.access.isGlobalAdmin && button.dataset.view === 'system';
      }
      byId('companyAdminManagement').hidden = !state.access.isGlobalAdmin;
      document.querySelector('[data-go="system"]')?.toggleAttribute('hidden', !state.access.isGlobalAdmin);
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
      setText('adminBadge', state.user.firstName || state.user.username || 'Admin');
      showView('overview');
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
      toast('Activation policy PostgreSQL’da saqlandi.');
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
    const confirmation = action === 'approve' ? 'Ushbu qurilma aktivatsiyasini tasdiqlaysizmi?' : action === 'reject' ? 'Ushbu aktivatsiya so‘rovini rad etasizmi?' : 'Ushbu qurilma aktivatsiyasini Ed25519 bilan bekor qilasizmi?';
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
      toast(action === 'approve' ? 'Aktivatsiya imzolandi va PostgreSQL’da tasdiqlandi.' : action === 'reject' ? 'So‘rov PostgreSQL’da rad etildi.' : 'Aktivatsiya imzolanib bekor qilindi.');
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
      try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch {}
      void loadCurrentView();
    });
    byId('mobileBackButton')?.addEventListener('click', () => { handleNavigateBack(); });
    byId('mainNav').addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (button) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch {}
        showView(button.dataset.view);
      }
    });
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-go]');
      if (target) {
        try { telegram?.HapticFeedback?.impactOccurred?.('light'); } catch {}
        showView(target.dataset.go);
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
    byId('balanceCompanySelect').addEventListener('change', () => { void loadBalances(); });
    byId('approveActivation').addEventListener('click', () => { void submitActivationAction('approve'); });
    byId('rejectActivation').addEventListener('click', () => { void submitActivationAction('reject'); });
    byId('revokeActivation').addEventListener('click', () => { void submitActivationAction('revoke'); });
    byId('signOutButton').addEventListener('click', () => clearSession('Sessiya yopildi. Panelni Telegram’dan qayta oching.'));
    byId('workerEditForm').addEventListener('submit', (event) => { void submitWorkerEdit(event); });
    byId('workerStatusButton').addEventListener('click', () => { void changeWorkerStatus(); });
    byId('closeWorkerDialog').addEventListener('click', () => byId('workerDialog').close());
  }

  bindEvents();
  void beginAuthentication();
})();
