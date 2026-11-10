
    // Initialize Telegram WebApp strictly in Light Mode
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      try {
        tg.setHeaderColor('#ffffff');
        tg.setBackgroundColor('#f8fafc');
        if (tg.headerColor) tg.headerColor = '#ffffff';
        if (tg.backgroundColor) tg.backgroundColor = '#f8fafc';
      } catch (e) {}
    }

    function triggerHaptic(type = 'light') {
      try {
        if (tg?.HapticFeedback) {
          if (type === 'light') tg.HapticFeedback.impactOccurred('light');
          else if (type === 'medium') tg.HapticFeedback.impactOccurred('medium');
          else if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
        }
      } catch (e) {}
    }

    // Signed worker context is validated by the VPS API; no client-side database credentials exist.
    const WORKER_SESSION_KEY = 'novda_worker_session_v1';
    function loadSavedSession() {
      try {
        const raw = localStorage.getItem(WORKER_SESSION_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return null;
    }
    function saveSession(session) {
      try {
        localStorage.setItem(WORKER_SESSION_KEY, JSON.stringify(session));
      } catch (e) {}
    }

    const urlParams = new URLSearchParams(window.location.search);
    const isWorkerOnboarding = urlParams.get('onboarding') === '1';
    let targetWorkerId = urlParams.get('workerId');
    let companyId = urlParams.get('companyId');
    let paramTelegramId = urlParams.get('telegramId');
    let expiresAt = urlParams.get('expiresAt');
    let workerAuthToken = urlParams.get('authToken');

    if (targetWorkerId && workerAuthToken) {
      saveSession({
        workerId: targetWorkerId,
        companyId: companyId,
        telegramId: paramTelegramId,
        expiresAt: expiresAt,
        authToken: workerAuthToken
      });
    } else if (!isWorkerOnboarding) {
      const saved = loadSavedSession();
      if (saved && saved.workerId && saved.authToken) {
        targetWorkerId = saved.workerId;
        companyId = saved.companyId || companyId;
        paramTelegramId = saved.telegramId || paramTelegramId;
        expiresAt = saved.expiresAt || expiresAt;
        workerAuthToken = saved.authToken;
      }
    }

    function workerTicketSearchKey() {
      return `hisob.worker.ticket-search.v1:${JSON.stringify([companyId || '', targetWorkerId || '', paramTelegramId || ''])}`;
    }
    function readWorkerTicketSearch() {
      try { return window.sessionStorage.getItem(workerTicketSearchKey()) || ''; } catch { return ''; }
    }
    function saveWorkerTicketSearch(value) {
      try { window.sessionStorage.setItem(workerTicketSearchKey(), value); } catch { /* Search remains usable without storage. */ }
    }

    function workerApiUrl(path) {
      const url = new URL(path, window.location.origin);
      url.searchParams.set('companyId', companyId || '');
      url.searchParams.set('workerId', targetWorkerId || '');
      url.searchParams.set('telegramId', paramTelegramId || '');
      url.searchParams.set('expiresAt', expiresAt || '');
      return url.toString();
    }

    function fetchWorkerApi(path) {
      return fetch(workerApiUrl(path), {
        headers: { 'x-worker-auth-token': workerAuthToken || '' },
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
    }

    const state = {
      workerId: targetWorkerId ? Number(targetWorkerId) : null,
      companyId: companyId,
      worker: null,
      models: [],
      currentPeriod: null,
      submittedTickets: [],
      ticketQuery: readWorkerTicketSearch(),
      calculations: {
        gross: 0,
        avans: 0,
        jarima: 0,
        staj: 0,
        net: 0,
        pieces: 0,
        modelsBreakdown: {}
      },
      isLoading: false
    };

    function formatMoney(num) {
      return (Number(num) || 0).toLocaleString('uz-UZ') + " so'm";
    }

    function formatNumber(num) {
      return (Number(num) || 0).toLocaleString('uz-UZ');
    }

    function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Switch Tabs
    window.switchTab = function(tabName) {
      try {
        if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
      } catch(e) {}

      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      const homeSection = document.getElementById('tabContentHome');
      const opsSection = document.getElementById('tabContentOps');
      const ticketsSection = document.getElementById('tabContentTickets');
      const aboutSection = document.getElementById('tabContentAbout');

      if (tabName === 'home') {
        const n = document.getElementById('botNavHome'); if (n) n.classList.add('active');
        if (homeSection) homeSection.style.display = 'block';
        if (opsSection) opsSection.style.display = 'none';
        if (ticketsSection) ticketsSection.style.display = 'none';
        if (aboutSection) aboutSection.style.display = 'none';
      } else if (tabName === 'ops') {
        const n = document.getElementById('botNavOps'); if (n) n.classList.add('active');
        if (homeSection) homeSection.style.display = 'none';
        if (opsSection) opsSection.style.display = 'block';
        if (ticketsSection) ticketsSection.style.display = 'none';
        if (aboutSection) aboutSection.style.display = 'none';
      } else if (tabName === 'tickets') {
        const n = document.getElementById('botNavTickets'); if (n) n.classList.add('active');
        if (homeSection) homeSection.style.display = 'block';
        if (opsSection) opsSection.style.display = 'none';
        if (ticketsSection) ticketsSection.style.display = 'block';
        if (aboutSection) aboutSection.style.display = 'none';
      } else if (tabName === 'about') {
        const n = document.getElementById('botNavAbout'); if (n) n.classList.add('active');
        if (homeSection) homeSection.style.display = 'none';
        if (opsSection) opsSection.style.display = 'none';
        if (ticketsSection) ticketsSection.style.display = 'none';
        if (aboutSection) aboutSection.style.display = 'block';
      }
    };

    // Load the bound worker projection and activity from the PostgreSQL-backed API.
    async function loadWorkerData(options = {}) {
      const isSilent = options && options.silent === true;
      if (state.isLoading) return;
      state.isLoading = true;
      const refreshBtn = document.getElementById('refreshBtn');
      if (!isSilent && refreshBtn) refreshBtn.classList.add('spinning');
      try {
        const tgUser = tg?.initDataUnsafe?.user;
        const currentTgId = tgUser?.id ? String(tgUser.id) : paramTelegramId;

        // If not bound or first time entering without credentials, show Ulanish screen
        if (isWorkerOnboarding || urlParams.get('mode') === 'bind' || urlParams.get('onboard') === 'true' || !targetWorkerId || !workerAuthToken) {
          showWorkerBindScreen(urlParams.get('workerId') || '', '', companyId || '');
          return;
        }

        hideWorkerBindScreen();

        if (!currentTgId || !companyId || !/^\d+$/.test(targetWorkerId || '') || !/^\d{1,24}$/.test(currentTgId)
          || !/^\d+$/.test(expiresAt || '') || !/^[a-f0-9]{64}$/.test(workerAuthToken || '')) {
          if (!isSilent) renderError("Xavfsizlik cheklovi: Ushbu sahifaga faqat rasmiy Telegram botdagi tugma orqali kirish mumkin.");
          return;
        }

        if (tgUser?.id && String(tgUser.id) !== String(paramTelegramId)) {
          if (!isSilent) renderError("Xavfsizlik cheklovi: Ushbu havola boshqa Telegram akkauntiga tegishli! Birovning hisobiga kirish taqiqlangan.");
          return;
        }

        const profileResponse = await fetchWorkerApi('/api/worker/profile');
        const profileResult = await profileResponse.json();
        if (!profileResponse.ok || !profileResult?.success || !profileResult.profile) {
          if (!isSilent) renderError("Shaxsiy ma'lumotlarni yuklab bo'lmadi. Bot orqali qayta kiring.");
          return;
        }
        const profile = profileResult.profile;
        if (String(profile.worker_id) !== String(targetWorkerId) || profile.company_id !== companyId) {
          if (!isSilent) renderError("Xavfsizlik cheklovi: server qaytargan ishchi yoki korxona mos kelmadi.");
          return;
        }

        state.workerId = Number(profile.worker_id);
        state.companyId = profile.company_id;
        state.worker = { id: profile.worker_id, name: profile.worker_name };
        state.models = Object.values(profile.models_breakdown || {});
        state.currentPeriod = profile.period ? {
          name: profile.period_name,
          isClosed: Boolean(profile.period.isClosed)
        } : { name: profile.period_name, isClosed: false };
        state.calculations = {
          gross: Number(profile.gross) || 0,
          pieceworkGross: Number(profile.pieceworkGross) || 0,
          oklad: Number(profile.oklad) || 0,
          magazin: Number(profile.magazin) || 0,
          avans: Number(profile.avans) || 0,
          jarima: Number(profile.jarima) || 0,
          staj: Number(profile.staj) || 0,
          net: Number(profile.net) || 0,
          accountingStatus: profile.accountingStatus,
          unknownEntryCount: Number(profile.unknownEntryCount) || 0,
          unresolvedAdjustmentCount: Number(profile.unresolvedAdjustmentCount) || 0,
          pieces: Number(profile.pieces) || 0,
          modelsBreakdown: profile.models_breakdown || {}
        };

        // Render UI
        renderHeader();
        renderHero();
        renderOperations();

        // Fetch tickets in background
        await fetchWorkerTickets();

      } catch (err) {
        if (!isSilent) {
          console.warn('Worker data request failed.');
          renderError("Ma'lumotlarni yuklashda xatolik yuz berdi. Internet aloqasini tekshiring.");
        }
      } finally {
        state.isLoading = false;
        if (refreshBtn) refreshBtn.classList.remove('spinning');
      }
    }

    function renderHeader() {
      const w = state.worker;
      const avatarEl = document.getElementById('avatarBadge');
      if (avatarEl) avatarEl.textContent = '';

      const nameEl = document.getElementById('workerNameHeader');
      if (nameEl) {
        nameEl.textContent = w.name || 'Ishchi';
      }

      const periodEl = document.getElementById('periodNameText');
      const p = state.currentPeriod;
      if (periodEl) periodEl.textContent = p?.name || 'Davr tanlanmagan';

      if (p?.isClosed) {
        const badge = document.getElementById('periodStatusBadge');
        if (badge) {
          badge.textContent = "Yopilgan";
          badge.style.color = "var(--danger)";
          badge.style.borderColor = "var(--danger-border)";
          badge.style.background = "var(--danger-light)";
        }
      }

      const brandEl = document.getElementById('brandCompanyName');
      if (brandEl) brandEl.textContent = state.companyId || '';

      const aboutId = document.getElementById('aboutWorkerId');
      if (aboutId) aboutId.textContent = w.id ? `#${w.id}` : '—';
      const aboutName = document.getElementById('aboutWorkerName');
      if (aboutName) aboutName.textContent = w.name || 'Ishchi';
      const aboutCompany = document.getElementById('aboutCompanyId');
      if (aboutCompany) aboutCompany.textContent = state.companyId || '—';
    }

    function renderHero() {
      const c = state.calculations;
      const unavailable = c.accountingStatus === 'UNAVAILABLE';
      const incomplete = c.accountingStatus !== 'COMPLETE';
      const netEl = document.getElementById('netPayAmount');

      const netFormatted = `${formatNumber(c.net)}${incomplete ? ' (oraliq)' : ''}`;
      netEl.textContent = `${netFormatted} so'm`;
      netEl.innerHTML = `${escapeHtml(netFormatted)} <span class="hero-curr">so'm</span>`;

      const subtitleEl = document.getElementById('netPaySubtitle');
      if (subtitleEl) {
        subtitleEl.textContent = unavailable
          ? '⚠️ Davr mavjud emas; oylik hisoblanmagan.' : incomplete
          ? `⚠️ Hisob to‘liq emas: ${c.unknownEntryCount} ta ish narxi noma’lum, ${c.unresolvedAdjustmentCount} ta tuzatish aniqlanmagan. Faqat aniqlangan ishlar hisoblangan; bu yakuniy oylik emas.`
          : "Avans, jarima va staj ushlanmalari ayirilgandan so'ng qo'lga tegadigan pul";
      }
      if (c.net < 0) {
        netEl.classList.add('negative');
      } else {
        netEl.classList.remove('negative');
      }

      const grossEl = document.getElementById('grossPayAmount');
      if (grossEl) grossEl.textContent = `${formatNumber(c.pieceworkGross)}${incomplete ? ' (oraliq)' : ''}`;
      const avansEl = document.getElementById('avansAmount');
      if (avansEl) avansEl.textContent = c.avans ? formatNumber(c.avans) : '—';
      const jarimaEl = document.getElementById('jarimaAmount');
      if (jarimaEl) jarimaEl.textContent = c.jarima ? formatNumber(c.jarima) : '—';

      const okladEl = document.getElementById('okladAmount');
      if (okladEl) okladEl.textContent = `${formatMoney(c.oklad)}${incomplete ? ' (oraliq)' : ''}`;
      const grossTotalEl = document.getElementById('grossTotalAmount');
      if (grossTotalEl) grossTotalEl.textContent = `${formatMoney(c.gross)}${incomplete ? ' (oraliq)' : ''}`;
      const magazinEl = document.getElementById('magazinAmount');
      if (magazinEl) magazinEl.textContent = formatMoney(c.magazin);
      const stajEl = document.getElementById('stajAmount');
      if (stajEl) document.getElementById('stajAmount').textContent = formatMoney(c.staj);
      const totalPiecesEl = document.getElementById('totalPiecesCount');
      if (totalPiecesEl) totalPiecesEl.textContent = formatNumber(c.pieces);
    }

    function renderOperations() {
      const listEl = document.getElementById('modelsBreakdownList');
      const opsFullListEl = document.getElementById('opsFullList');
      const mb = state.calculations.modelsBreakdown || {};
      const keys = Object.keys(mb);
      const badge = document.getElementById('modelsCountBadge');
      if (badge) badge.textContent = keys.length;

      let opCount = 0;
      for (const mId of keys) {
        if (Array.isArray(mb[mId]?.operations)) opCount += mb[mId].operations.length;
      }
      const opsCountEl = document.getElementById('operationsCount');
      if (opsCountEl) opsCountEl.textContent = opCount;
      const opsCountBadge = document.getElementById('opsCountBadge');
      if (opsCountBadge) opsCountBadge.textContent = `${opCount} ta operatsiya`;
      const opsPiecesTotal = document.getElementById('opsPiecesTotal');
      if (opsPiecesTotal) opsPiecesTotal.textContent = `${formatNumber(state.calculations.pieces)} dona`;
      const opsNetPayTotal = document.getElementById('opsNetPayTotal');
      if (opsNetPayTotal) opsNetPayTotal.textContent = state.currentPeriod ? `${formatNumber(state.calculations.net)} so'm` : '—';
      const pName = state.currentPeriod?.name?.replace(/^\d{4}\s*—\s*/, '') || '';
      const opsPeriodLabel = document.getElementById('opsPeriodLabel');
      if (opsPeriodLabel) opsPeriodLabel.textContent = pName ? `${pName} · jami` : 'Davr tanlanmagan';

      if (!keys.length) {
        if (listEl) listEl.innerHTML = '<div class="op-item-row">Hozircha ishlar mavjud emas.</div>';
        if (opsFullListEl) opsFullListEl.innerHTML = '<div class="ops-card-block">Hozircha ishlar mavjud emas.</div>';
        return;
      }

      let html = '';
      for (const mId of keys) {
        const m = mb[mId];
        for (const op of m.operations) {
          const isUnknownRate = op.rate == null;
          const amountStr = op.amount == null ? 'Summa noma’lum' : `${formatNumber(op.amount)} so'm`;
          const subStr = `${escapeHtml(m.name)}${isUnknownRate ? ' · Narx noma’lum' : (op.rate != null ? ` · ${formatNumber(op.rate)} so'm / dona` : '')}`;
          html += `
            <div class="op-item-row">
              <div class="op-item-info">
                <div class="op-item-title">${escapeHtml(op.name)}</div>
                <div class="op-item-sub">${subStr}</div>
              </div>
              <div class="op-item-meta">
                <div class="op-item-amount">${amountStr}</div>
                <div class="op-item-qty">${formatNumber(op.qty)} dona</div>
              </div>
            </div>
          `;
        }
      }
      if (listEl) listEl.innerHTML = html;
      if (opsFullListEl) {
        opsFullListEl.innerHTML = `
          <div class="ops-date-header">JARAYONLAR</div>
          <div class="ops-card-block">${html}</div>
        `;
      }
    }

      // Fetch and render tickets that belong to this worker
      async function fetchWorkerTickets() {
        const ticketsListEl = document.getElementById('ticketsList');
        try {
          const res = await fetchWorkerApi('/api/worker/tickets?limit=50');
          const response = await res.json();
          if (!res.ok || !response?.success) throw new Error('WORKER_TICKETS_UNAVAILABLE');
          const myTickets = Array.isArray(response.tickets) ? response.tickets : [];
          state.submittedTickets = myTickets;
          renderWorkerTickets();

        } catch (e) {
          console.warn('Tickets error:', e);
          ticketsListEl.innerHTML = '<div class="empty-state">Pattalarni yuklashda xatolik yuz berdi.</div>';
        }
      }

      function renderWorkerTickets() {
        const ticketsListEl = document.getElementById('ticketsList');
        const query = state.ticketQuery.trim().toLocaleLowerCase();
        const matches = state.submittedTickets.filter((ticket) => !query || [ticket.model_id, ticket.patta_number,
          ticket.party_number, ticket.size, ticket.color, ticket.my_operations, ticket.submitted_at]
          .some((value) => String(value ?? '').toLocaleLowerCase().includes(query)));
        document.getElementById('ticketsCountBadge').textContent = matches.length;
        document.getElementById('ticketFilterCount').textContent = `${matches.length} / ${state.submittedTickets.length} ta patta`;
        if (!matches.length) {
          ticketsListEl.innerHTML = '<div class="empty-state">Qidiruv bo‘yicha patta topilmadi.</div>';
          return;
        }
        let html = '';
        for (const t of matches.slice(0, 50)) { // show latest 50 matching records
            html += `
              <div class="ticket-item">
                <div class="ticket-top">
                  <span class="ticket-badge-id">${escapeHtml(t.model_id || 'Model')} &bull; Patta #${escapeHtml(t.patta_number || 1)}</span>
                  <span class="ticket-time">⏱️ ${escapeHtml(t.submitted_at || '')}</span>
                </div>
                <div class="ticket-tags">
                  <span class="ticket-tag">Partiya: ${escapeHtml(t.party_number || '-')}</span>
                  <span class="ticket-tag">Razmer: ${escapeHtml(t.size || '-')}</span>
                  <span class="ticket-tag">Rang: ${escapeHtml(t.color || '-')}</span>
                  <span class="ticket-tag" style="color: var(--success); font-weight: 700;">Soni: ${formatNumber(t.qty || 0)} dona</span>
                </div>
                <div class="ticket-my-op">
                  <span>Bajarilgan chok:</span>
                  <span style="font-weight: 700; color: var(--accent);">${escapeHtml(t.my_operations || 'Tikuv')}</span>
                </div>
              </div>
            `;
          }
        ticketsListEl.innerHTML = html;
      }

      function renderError(msg) {
        document.getElementById('modelsBreakdownList').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <div style="font-weight: 700; color: var(--danger); margin-bottom: 6px;">Xatolik</div>
            <div>${escapeHtml(msg)}</div>
          </div>
        `;
      }

    // Event Listeners
    document.getElementById('refreshBtn').addEventListener('click', () => {
      triggerHaptic('medium');
      loadWorkerData();
    });
    document.getElementById('ticketHistorySearch').value = state.ticketQuery;
    document.getElementById('ticketHistorySearch').addEventListener('input', (event) => {
      state.ticketQuery = event.target.value;
      saveWorkerTicketSearch(state.ticketQuery);
      renderWorkerTickets();
    });


    function showWorkerBindScreen(initialId = '', initialName = '', company = '') {
      const bindContainer = document.getElementById('workerBindContainer');
      const dashboardContainer = document.getElementById('dashboardContainer');
      const bottomNav = document.querySelector('.bottom-nav');
      if (bindContainer) bindContainer.style.display = 'flex';
      if (dashboardContainer) dashboardContainer.style.display = 'none';
      if (bottomNav) bottomNav.style.display = 'none';

      document.body.classList.add('worker-bind-view');

      const idInput = document.getElementById('workerIdInput');
      const foundName = document.getElementById('workerFoundName');
      const foundCard = document.getElementById('workerFoundCard');
      const brandName = document.getElementById('workerBrandName');
      const subtitle = document.getElementById('workerBindSubtitle');
      const cameraCard = document.getElementById('workerCameraCard');

      const co = company || companyId || '';
      if (brandName) brandName.textContent = co;
      if (subtitle) subtitle.textContent = co ? `${co} ishchi ilovasi` : 'Ishchi ilovasi';

      if (idInput && initialId) idInput.value = initialId;
      if (foundName && initialName) foundName.textContent = initialName;
      if (foundCard) foundCard.style.display = initialName ? 'flex' : 'none';
      if (cameraCard) cameraCard.style.display = isWorkerOnboarding ? 'flex' : 'none';
    }

    function hideWorkerBindScreen() {
      const bindContainer = document.getElementById('workerBindContainer');
      const dashboardContainer = document.getElementById('dashboardContainer');
      const bottomNav = document.querySelector('.bottom-nav');
      if (bindContainer) bindContainer.style.display = 'none';
      if (dashboardContainer) dashboardContainer.style.display = 'block';
      if (bottomNav) bottomNav.style.display = 'flex';

      document.body.classList.remove('worker-bind-view');
    }



    window.setOpsFilter = function(type) {
      document.querySelectorAll('.ops-filter-chip').forEach(c => c.classList.remove('active'));
      if (type === 'all') document.getElementById('chipHammasi')?.classList.add('active');
      else if (type === 'week') document.getElementById('chipHafta')?.classList.add('active');
    };

    window.toggleOpsModelDropdown = function() {
      // Model filter dropdown
    };

    const opsSearchInput = document.getElementById('opsSearchInput');
    if (opsSearchInput) {
      opsSearchInput.addEventListener('input', () => {
        const query = opsSearchInput.value.trim().toLowerCase();
        document.querySelectorAll('#opsFullList .op-item-row').forEach(row => {
          const text = row.textContent.toLowerCase();
          row.style.display = (!query || text.includes(query)) ? 'flex' : 'none';
        });
        document.querySelectorAll('#opsFullList .ops-card-block').forEach(block => {
          const hasVisible = Array.from(block.querySelectorAll('.op-item-row')).some(r => r.style.display !== 'none');
          block.style.display = hasVisible ? 'block' : 'none';
          const header = block.previousElementSibling;
          if (header && header.classList.contains('ops-date-header')) {
            header.style.display = hasVisible ? 'block' : 'none';
          }
        });
      });
    }

    window.showWorkerBindScreen = showWorkerBindScreen;
    window.hideWorkerBindScreen = hideWorkerBindScreen;

    const workerIdInput = document.getElementById('workerIdInput');
    let onboardingPhoto = '';
    let cameraStream = null;
    const cameraVideo = document.getElementById('workerCameraPreview');
    const photoPreview = document.getElementById('workerPhotoPreview');
    const cameraStatus = document.getElementById('workerCameraStatus');
    const cameraStartButton = document.getElementById('workerCameraStartBtn');
    const cameraCaptureButton = document.getElementById('workerCameraCaptureBtn');
    const cameraFileInput = document.getElementById('workerCameraFileInput');
    let useNativeCameraCapture = false;
    function setOnboardingPhoto(source) {
      const renderPhoto = (image) => {
        const canvas = document.getElementById('workerCameraCanvas');
        if (!canvas) return;
        const sourceWidth = image.videoWidth || image.naturalWidth || image.width;
        const sourceHeight = image.videoHeight || image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) {
          if (cameraStatus) cameraStatus.textContent = 'Surat hali tayyor emas. Qayta urinib ko‘ring.';
          return;
        }
        const scale = Math.min(1, 900 / sourceWidth, 900 / sourceHeight);
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        onboardingPhoto = canvas.toDataURL('image/jpeg', 0.58);
        if (photoPreview) {
          photoPreview.src = onboardingPhoto;
          photoPreview.style.display = 'block';
        }
        cameraVideo.style.display = 'none';
        cameraCaptureButton.style.display = 'none';
        cameraStartButton.style.display = 'block';
        cameraStartButton.textContent = 'Suratni qayta olish';
        if (cameraStatus) cameraStatus.textContent = 'Surat olindi. Ishchi ID raqamingizni kiriting.';
        updateOnboardingSubmit();
      };
      if (typeof source !== 'string') {
        renderPhoto(source);
        return;
      }
      const image = new Image();
      image.onload = () => renderPhoto(image);
      image.onerror = () => { if (cameraStatus) cameraStatus.textContent = 'Suratni o‘qib bo‘lmadi. Qaytadan suratga oling.'; };
      image.src = source;
    }
    cameraFileInput?.addEventListener('change', () => {
      const file = cameraFileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setOnboardingPhoto(String(reader.result || ''));
      reader.onerror = () => { if (cameraStatus) cameraStatus.textContent = 'Suratni ochib bo‘lmadi. Qayta urinib ko‘ring.'; };
      reader.readAsDataURL(file);
    });
    cameraStartButton?.addEventListener('click', async () => {
      if (useNativeCameraCapture || !navigator.mediaDevices?.getUserMedia) {
        cameraFileInput?.click();
        if (cameraStatus) cameraStatus.textContent = 'Old kamera ochilmoqda…';
        return;
      }
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' }, width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
        cameraVideo.srcObject = cameraStream;
        cameraVideo.style.display = 'block';
        photoPreview.style.display = 'none';
        await cameraVideo.play();
        cameraStartButton.style.display = 'none';
        if (cameraVideo.videoWidth) cameraCaptureButton.style.display = 'block';
        else cameraVideo.addEventListener('loadedmetadata', () => { cameraCaptureButton.style.display = 'block'; }, { once: true });
        if (cameraStatus) cameraStatus.textContent = 'Kameraga ruxsat berildi. Yuzingizni kadrga joylashtiring.';
      } catch {
        useNativeCameraCapture = true;
        cameraStartButton.textContent = 'Old kamerani ochish';
        if (cameraStatus) cameraStatus.textContent = 'WebView kamerasi ochilmadi. “Old kamerani ochish” tugmasini bosing.';
      }
    });
    cameraCaptureButton?.addEventListener('click', () => {
      if (!cameraVideo?.videoWidth) {
        if (cameraStatus) cameraStatus.textContent = 'Kamera hali tayyor emas. Bir oz kutib qayta bosing.';
        return;
      }
      setOnboardingPhoto(cameraVideo);
      cameraStream?.getTracks().forEach(track => track.stop());
      cameraVideo.srcObject = null;
    });

    function updateOnboardingSubmit() {
      const submitBtn = document.getElementById('workerSubmitRequestBtn');
      if (submitBtn && isWorkerOnboarding) {
        submitBtn.disabled = !onboardingPhoto || !/^\d{1,9}$/.test(workerIdInput?.value.trim() || '');
      }
    }
    if (workerIdInput) {
      workerIdInput.addEventListener('input', async () => {
        const val = workerIdInput.value.trim();
        const foundCard = document.getElementById('workerFoundCard');
        const foundName = document.getElementById('workerFoundName');
        const submitBtn = document.getElementById('workerSubmitRequestBtn');
        if (!val) {
          if (foundCard) foundCard.style.display = 'none';
          if (submitBtn) submitBtn.disabled = true;
          return;
        }
        try {
          if (!companyId) throw new Error('COMPANY_ID_REQUIRED');
          const resp = await fetch(`/api/worker/enrollment-check?companyId=${encodeURIComponent(companyId)}&workerId=${encodeURIComponent(val)}`);
          if (resp.ok) {
            const data = await resp.json();
            if (data.success && data.worker && data.worker.worker_name) {
              if (foundName) foundName.textContent = data.worker.worker_name;
              if (foundCard) foundCard.style.display = 'flex';
              if (submitBtn) submitBtn.disabled = isWorkerOnboarding ? (!onboardingPhoto || !/^\d{1,9}$/.test(val)) : false;
              return;
            }
          }
        } catch (e) {}
        if (foundCard) foundCard.style.display = 'none';
        if (submitBtn) submitBtn.disabled = true;
      });
    }

    document.getElementById('workerSubmitRequestBtn')?.addEventListener('click', async () => {
      triggerHaptic('success');
      const val = document.getElementById('workerIdInput')?.value.trim();
      if (isWorkerOnboarding) {
        const submit = document.getElementById('workerSubmitRequestBtn');
        const status = document.getElementById('workerCameraStatus');
        const currentTgId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : paramTelegramId;
        if (!onboardingPhoto || !currentTgId || !/^\d{1,9}$/.test(val || '')) return;
        submit.disabled = true;
        if (status) status.textContent = 'Profil saqlanmoqda…';
        try {
          const response = await fetch('/api/worker/onboarding-bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-worker-auth-token': workerAuthToken || '' },
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            body: JSON.stringify({ companyId, telegramId: currentTgId, expiresAt, workerId: Number(val),
              username: tg?.initDataUnsafe?.user?.username || '', photo: onboardingPhoto })
          });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error?.code || 'SAQLASH_XATOSI');
          if (status) status.textContent = 'Profil muvaffaqiyatli ulandi. Botga qayting va hisobingizni oching.';
          try { tg?.HapticFeedback?.notificationOccurred('success'); } catch {}
          try { tg?.sendData?.(JSON.stringify({ action: 'onboarding_complete' })); } catch {}
          setTimeout(() => { try { tg?.close?.(); } catch {} }, 1000);
        } catch (error) {
          if (status) status.textContent = `Ulab bo‘lmadi: ${error.message}. Ma’lumotlarni tekshirib qayta urinib ko‘ring.`;
          updateOnboardingSubmit();
        }
        return;
      }
      if (tg && typeof tg.sendData === 'function') {
        try {
          if (!companyId) {
            const status = document.getElementById('workerCameraStatus');
            if (status) status.textContent = 'Kompaniya ma’lumoti topilmadi. Administratorga murojaat qiling.';
            return;
          }
          tg.sendData(JSON.stringify({ action: 'bind_request', workerId: val, companyId }));
          return;
        } catch (e) {}
      }
      alert('So‘rov yuborildi. Admin tasdiqlagach hisobingiz ochiladi.');
    });

    document.getElementById('workerCloseBtn')?.addEventListener('click', () => {
      try { tg?.close?.(); } catch (e) {}
    });

    // Auto-refresh: Automatically update worked amounts in real-time
    let workerAutoRefreshTimer = null;
    function startWorkerAutoRefresh() {
      if (workerAutoRefreshTimer) clearInterval(workerAutoRefreshTimer);
      workerAutoRefreshTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden' && !state.isLoading && state.workerId) {
          loadWorkerData({ silent: true });
        }
      }, 10000);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.isLoading && state.workerId) {
        loadWorkerData({ silent: true });
      }
    });

    window.addEventListener('focus', () => {
      if (!state.isLoading && state.workerId) {
        loadWorkerData({ silent: true });
      }
    });

    // Auto-boot
    loadWorkerData();
    startWorkerAutoRefresh();
