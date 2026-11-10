# Novda Hisob-Kitob

## Loyiha tuzilishi

- `apps/desktop/` — Electron ishga tushirish qismi va React desktop interfeysi.
- `apps/server/` — API, biznes modullar va PostgreSQL migratsiyalari.
- `apps/bots/admin/` va `apps/bots/worker/` — Telegram botlar; testlar har bir botning `tests/` papkasida.
- `apps/webapps/admin/` va `apps/webapps/worker/` — server orqali taqdim etiladigan Telegram WebApp interfeyslari.
- `apps/bots/superadmin/` va `apps/webapps/superadmin/` — alohida superadmin uchun hali ishga tushirilmagan bo'sh asos.
- `packages/domain/` — ilovalar o'rtasida umumiy biznes qoidalar.
- `packages/contracts/` — umumiy litsenziya va serializatsiya kontraktlari.
- `packages/assets/fonts/` — ilovalar foydalanadigan shriftlar va litsenziyalari.
- `ops/deploy/` — Docker Compose, image va deploy operatsiyalari.
- `ops/systemd/`, `ops/monitoring/`, `ops/postgres/` — server ekspluatatsiyasi konfiguratsiyalari va yordamchi vositalari.
- `ops/docs/` — operatsion qo‘llanmalar va boshqaruv hujjatlari, jumladan [`PRODUCTION.md`](ops/docs/PRODUCTION.md).
- `scripts/build/`, `scripts/tools/`, `scripts/verify/` — build, yordamchi vositalar va tekshiruvlar.

`index.html` va `vite.config.mts` desktop rendererning Vite kirish nuqtasi va konfiguratsiyasidir. `package.json` ildizdagi build va test buyruqlarini belgilaydi.

Production ma'lumotlariga tegadigan migratsiya, backup, restore va deploy yo'llarini o'zgartirishdan oldin VPS'dagi amaldagi xizmatlar va alohida backup tekshirilishi kerak.
