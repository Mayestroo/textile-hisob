# Backup asosidagi audit va stabilizatsiya — 2026-11-10

> Phase 2 yangilanishi hujjat oxirida. Quyidagi birinchi paket natijalari tarixiy
> dalil sifatida saqlangan; eski arxiv/admin UI blockerlarining joriy holati uchun
> **Phase 2** bo‘limini o‘qing.

## Natija va chegaralar

Bu birinchi stabilizatsiya paketi, butun tizim uchun yakuniy production sign-off emas.
Quyidagi muammolar real backup/HTTP/Electron oqimlarida yoki aniq xavfli kod yo‘lida
tasdiqlandi va tuzatildi. Ikki eski arxivning ochilishi va eski admin UI acceptance
harnessi hali ochiq masala. Testlarning o‘tishi tizim bug-free ekanini anglatmaydi.

Push, deploy, VPS ulanishi va production ma’lumotlariga yozish bajarilmadi.

## Ishlatilgan ma’lumot va muhit

- Manba: `novda_prod_20261110_074225.dump`, PostgreSQL custom format.
- SHA-256: `ce529a4afb44da7bafed55ccc26ecc2b7ba64b3241b9e382ed740b01399dda7e`.
- Backup server versiyasi: PostgreSQL 16.12; lokal Docker: PostgreSQL 16.15.
- Boshlang‘ich ma’lumot: 28 model, 222 ishchi, 252 partiya, 1 976 ticket,
  28 700 ticket entry, 73 worker adjustment, 216 production adjustment, 3 davr, 2 arxiv.
- Backup sxemasi 22-migratsiyada, joriy source 29-migratsiyada.
- `novda_local`: boshlang‘ich biznes ma’lumotlari saqlangan reference; tekshiruv
  oxirida ham 22 migratsiya / 222 ishchi / 1 976 ticket / 28 700 entry / 2 arxiv.
- `novda_local_current`: joriy source bilan moslashtirilgan, acceptance yozuvlarisiz
  lokal API nusxasi. API: `http://127.0.0.1:3476`.
- `novda_audit_current`, `novda_audit_final`: faqat acceptance tajribalari uchun nusxalar.
  Ularda yangi ishchi, tarif/balans o‘zgarishlari, VOIDED ticket va davr yopish natijalari bor.
- `novda_regression_test`: sintetik integration testlar uchun alohida disposable baza.
- PostgreSQL porti faqat `127.0.0.1:55432`ga bog‘langan.

Working nusxadagi 23–29 migratsiyalar prodga qo‘llangani yoki lokal muhit prod bilan
bit-for-bit bir xil ekani da’vo qilinmaydi. Data copy + bir xil runtime grant siyosati
asosida joriy source tekshirildi; original backup fayli reference bo‘lib qoldi.

## Tasdiqlangan sabablar va tuzatishlar

### 1. Ticket entry identifikatorlari ikki tomonda farq qilgan — yuqori

**Takrorlash:** shu desktopda ticket yaratish, sync qilish, model tarifini yangilash,
keyin ticket ishchisini almashtirish. UI lokal commitni qabul qilgan, server esa
`AMBIGUOUS_TICKET_ENTRY` bilan operatsiyani DEAD_LETTER qilgan.

**Sabab:** lokal submit `entry_<ticket>_<index>_<operation>_<worker>`, server esa
`<ticket>_entry_<ordinal>` yaratgan. O‘z INSERT feedi lokal entrylarni qayta
yaratmagan. Ilgari testlar odatda `entryId`ni bermasdan yoki oldindan seeded entry
bilan tahrirlashni tekshirgan, to‘liq UI yo‘li esa identifikatorni yuborgan.

**Tuzatish:** `packages/contracts/ticketEntryIdentity.cjs`da umumiy kontrakt.
Yangi lokal/server/feed entrylari bir xil ID oladi. Payroll acceptance proof va
outbox provenance recovery eski va yangi deterministik formatni taniydi. Server
eski desktop ID’sini faqat locked canonical row uchun hisoblangan aniq alias
bo‘lgandagina qabul qiladi; tasodifiy noma’lum ID operation-name orqali topilmaydi.

**Dalil:** real renderer submit → HTTP → PostgreSQL → worker reassignment → delete
o‘tdi. Yangi/legacy ID bilan ikki integration regression qo‘shildi. Original rate
snapshot o‘zgarmadi. Eski DEAD_LETTER operatsiyalarini avtomatik qayta yuborish yoki
ularning immutable payloadini o‘zgartirish bu paketda bajarilmadi.

### 2. Modellar orasida tez almashganda ticket drafti yo‘qolgan — yuqori

**Takrorlash:** birinchi modelga qty kiritish, 1.2 soniyadan oldin ikkinchisiga o‘tib
qty kiritish; SQLite o‘qilganda faqat ikkinchi draft saqlangan.

**Sabab:** barcha modellar bir xil `ticket_form` debounce kalitini ishlatgan,
ammo timer vazifasi faqat bitta modelni SQLite’ga yozgan.

**Tuzatish:** timer va submit paytidagi cancel kaliti korxona+modelga ajratildi.
Bir modelni yuborish boshqa model draftining timerini bekor qilmaydi.

**Dalil:** real preload/main IPC orqali ikki draftning diskka yozilishi tekshirildi;
regression bir modelni qayta tahrirlash ham ikkinchi modelni yo‘qotmasligini tekshiradi.

### 3. SQL DATE qiymatlari vaqt zonasi orqali siljigan — yuqori

**Takrorlash:** `Asia/Tashkent` muhitida backupdagi `2026-08-25` bootstrap javobida
`2026-08-24` bo‘lgan. Admin davr ro‘yxati/balans yo‘llari esa Date obyektiga
`String(...).slice(0, 10)` qo‘llab, ISO bo‘lmagan sana hosil qilishi mumkin edi.

**Sabab:** PostgreSQL DATE vaqt nuqtasi emas, lekin `pg` uni lokal Date obyektiga
aylantirgan; kod keyin uni UTC timestampdek ishlatgan.

**Tuzatish:** calendar-date SQL chegaralarida `start_date::text`, `end_date::text`.
Bootstrap, payroll, worker tickets, admin periods/balances, ticket period resolution,
month close va party-series completion yo‘llari qamraldi. Timestamp maydonlarining
UTC semantikasi o‘zgartirilmadi.

**Dalil:** barcha real backup davrlari HTTP orqali SQL matn sanalari bilan solishtirildi.
UTC, Asia/Tashkent, America/Los_Angeles subprocess regressionlari qo‘shildi.
Real month close yangi arxivda boshlanish/tugash sanalarini siljitmadi.

### 4. Sxema readiness va development startup bir-biriga mos bo‘lmagan — yuqori

**Takrorlash:** original 22-migratsiyali backup integrity tekshiruvidan o‘tgan, ammo
bootstrap API yangi ustunlarga murojaat qilib `42703` bilan yiqilgan.

**Sabab:** integrity faqat mavjud migratsiyalarning tartibi va nomini tekshirgan,
eng oxirgi required versiyagacha yetganini emas. Development init faqat
`schema.sql`ni o‘qigan; reset, deploy va verification turli ro‘yxatlarni saqlagan.

**Tuzatish:** yagona `apps/server/database/migrate.cjs` ro‘yxati/runneri. Development
init barcha migratsiyalarni bitta pinned connection orqali qo‘llaydi; xatoda u
connection qayta poolga sog‘lom deb qaytarilmaydi. Production startup avvalgidek
read-only tekshiradi, lekin endi to‘liq lineage talab qiladi. Production DSN/role
chegaralari o‘zgartirilmadi.

**Dalil:** yangi restore nusxasi old-schema sifatida rad etildi, so‘ng aynan
`initServerDatabase` orqali 29-migratsiyagacha muvaffaqiyatli ko‘tarildi. Regression
outdated-but-contiguous sxemani alohida rad etadi.

### 5. Destruktiv reset yordamchisida ichki himoya bo‘lmagan — yuqori xavf

**Sabab:** `resetServerDatabase` poolning har qanday ambient DSN’i bilan DROP TABLE
bajarishi mumkin edi; xavfsizlik faqat tashqi test launcheriga bog‘liq bo‘lgan.

**Tuzatish:** resetning o‘zi explicit disposable opt-in, production DSN yo‘qligi,
test/regression/disposable baza nomi, real current database va PG16 ni tekshiradi.
Production NODE_ENV’da ham reset taqiqlangan.

**Dalil:** production/implicit/nomi mos bo‘lmagan DSN’lar socket ochishdan oldin
rad etadigan regression; barcha PG integration testlari shu himoya bilan o‘tdi.
Bu production reset qilib tekshirilmagan va bunday tekshiruv bajarilmaydi.

### 6. Verification infratuzilmasi yashirincha eskirgan — o‘rta

- NSIS versiya testi release `2.0.0`ni eski `1.1.11` bilan solishtirgan: format va
  package/lockfile mosligi tekshiriladigan qilindi.
- Ikki `test_*_acceptance_driver.py` pytest import vaqtida stdin o‘qigan.
  Ular subprocess driver sifatida qayta nomlandi, chaqiruvlar yangilandi; haqiqiy
  Python testlari endi normal collect bo‘ladi.
- Ayrim standalone acceptance skriptlaridagi reorganization’dan qolgan relative
  require yo‘llari tuzatildi. Local-PG boundary yordamchisi endi ignored
  `.opencode/...` fayliga emas, version-controlled scriptga tayanadi.
- Bot acceptance fixture endi shared migration runnerdan foydalanadi; yangi
  davrda eski partiya/patta kalitini noqonuniy qayta ishlatadigan sintetik yozuv
  tuzatildi. Greeting moliyaviy hisobotni avtomatik chiqaradi degan eski taxmin
  o‘rniga `/hisob` alohida chaqiriladi.
- **Hali tugallanmagan:** shu standalone skriptning keyingi admin financial-UI VM
  qismi olib tashlangan `bindEvents`/`submitQuickAdjustment` entrypointiga bog‘liq.
  U `actual UI entrypoint changed` bilan to‘xtaydi. Bu tekshiruv PASS deb berilmaydi.

## Real workflow dalillari

`scripts/verify/database/backup-workflows.cjs --desktop --lifecycle` yangi restore
nusxasida bajarildi. Server `allowTestTokens` bilan ochilmagan: yangi local device
hashi va haqiqiy operator login/session ishlatildi. Runtime role aynan production
`production_roles.sql` grant siyosati orqali cheklangan.

Tasdiqlangan oqimlar:

1. Fresh SQLite → real HTTP bootstrap → 28 model / 222 ishchi / 1 976 ticket /
   28 700 entryning to‘liq qabul qilinishi.
2. Haqiqiy App + AuthGate → preload → main IPC → bootstrap → pull-first reconnect.
3. Sakkiz workbook view’ning backup qatorlari bilan render bo‘lishi.
4. Ikki model draftining debounce orqali mustaqil diskka yozilishi.
5. AVANS o‘zgarishi: lokal outbox → operator-authorized API → PostgreSQL → feed;
   takroriy reconnect balansni ikki marta qo‘shmagan.
6. Offline yangi ishchi: desktop canonical ID o‘ylab topmaydi; server rosterning
   maksimal ID’sidan keyingi ID’ni bir marta tayinlaydi.
7. Renderer ticket formasi → accepted PostgreSQL ticket. Alohida arifmetik dalil:
   piecework o‘zgarishi kiritilgan son × tarifga teng.
8. Tarif o‘zgarishi → ticket ishchisini almashtirish; saqlangan rate snapshot buzilmaydi.
9. Delete → serverdagi VOIDED tarix → active workbookdan yo‘qolish.
10. Oklad input’ida DOM focus/input/change/blur → davrga bog‘langan canonical balans.
11. Month close → yangi PostgreSQL arxiv → keyingi ochiq davr → patta numbering
    saqlanishi → yangi arxivning main IPC orqali o‘qilishi.

Barcha backup davrlari bo‘yicha desktop/server payroll summalari solishtirildi.
Bu ikki tomon bitta reducer ishlatgani sababli mustaqil buxgalteriya auditi emas;
mustaqil qty×tariff va exact-once balans tekshiruvlari alohida bajarildi.

## Ochiq muammolar va navbatdagi ustuvorlik

### Eski ikki arxiv — yuqori, hali tuzatilmagan

Real `PeriodArchiveRead` ikkala legacy arxivni ham
`ARCHIVE_TICKET_PERIOD_UNKNOWN` bilan rad etmoqda. Snapshotlarda 205 va 1 769
ticketning `periodId` maydoni yo‘q. Barchasining ID’si canonical ticketlarda bor,
ammo mos ravishda 93 va 618 snapshot ticketida partiya identifikatori ham yetishmaydi.
Bu raqamlar hammasi bir xil sabab bilan mos kelmayapti degani emas: arxivning
birinchi noaniq ticketi butun read’ni to‘xtatadi.

Keyingi ish: immutable archive digestini saqlagan holda aniq historical binding
dalili va read-only completeness kontraktini ishlab chiqish. Faqat sana yoki model
nomiga qarab avtomatik bog‘lash, unknown summalarni nolga aylantirish, hash/tenant
validatorini o‘chirish yoki original arxivni rewrite qilish bajarilmadi.

### Qolgan verification va scope chegaralari

- Eski admin financial-UI VM harnessi yangilanishi kerak; uning xatosi yuqorida yozilgan.
- Ikki mavjud test skip bo‘lib qoladi: DB’siz payroll-display testidagi mavjud skip va
  Docker opt-in talab qiluvchi PostgreSQL backup drill. PASS soniga qo‘shilmagan.
- Linter konfiguratsiyasi va npm lint scripti yo‘q; lint o‘tdi deb da’vo qilinmaydi.
- Real Telegram serverlari, VPS, reverse proxy/TLS, production signing key,
  physical printer, Windows installer upgrade va foydalanuvchining mavjud desktop
  profili bilan qo‘lda sinov bajarilmadi.
- Electron fixture faqat activation envelope’ni isolated processda almashtiradi;
  production license validation kodi o‘zgarmagan. Shuning uchun bu production
  activation approval/key issuance testining o‘rnini bosmaydi.
- Backupdagi tarixiy production adjustment attributioni migratsiya bilan taxminan
  to‘ldirilmadi; noma’lum ish haqi sabablarini alohida biznes dalillari bilan tekshirish zarur.
- Build’da katta XLSX chunk ogohlantirishi, dev rendererda stream-externalization
  ogohlantirishi bor. Real yuklama/network latency/ko‘p qurilma scale testi bajarilmadi.
- Kengroq dead-code, security threat-model va barcha UI edge-case auditlari hali
  yakunlangan emas. Bu hujjat tekshirilmagan joylarni sog‘lom deb belgilamaydi.

## Bajarilgan validation

- `npm run verify`: 82 test fayli, 723 test PASS, 1 mavjud skip;
  protected-file integrity, TypeScript va production build PASS.
- Alohida disposable PG suite: 36 test fayli PASS, 358 test PASS, 1 backup-drill skip.
- `python -m pytest apps/bots/admin/tests apps/bots/worker/tests -q`:
  37 test va 176 subtest PASS.
- `npm run verify:secrets`: PASS.
- Davr yopish acceptance’idan keyin PostgreSQL integrity qayta tekshirildi:
  29 migratsiya, 17 required FK valid, barcha 16 orphan hisoblagich 0,
  baseline scope saqlangan. `git diff --check` va yangi CJS entrypoint syntax checklari PASS.
- Backup workflow acceptance: yuqoridagi real oqimlar PASS; legacy archive risklari
  alohida qayd qilingan, "barcha workflowlar PASS" deyilmaydi.
- Standalone bot/admin acceptance: worker/signed API/admin write bosqichlaridan
  keyin eski financial UI VM entrypointida FAIL; umumiy PASS emas.

## Qayta bajarish

Backup acceptance faqat alohida `novda_audit_*` restore nusxasini qabul qiladi.
`NOVDA_AUDIT_DISPOSABLE=1` va `NOVDA_AUDIT_PG_URL`ni loopback DSN’ga sozlang;
`DATABASE_URL` va `NOVDA_PG_URL` unset bo‘lishi kerak. Keyin:

```text
node scripts/verify/database/backup-workflows.cjs --desktop
```

`--lifecycle`ni faqat yangi, tashlab yuborish mumkin bo‘lgan audit nusxasida qo‘shing:
u nusxada davrni yopadi. Bu skript read-only emas: audit device/operator/runtime
role, ishchi, balans va ticket o‘zgarishlarini yaratadi. Original dump yoki reference
bazani unga bermang. Izolyatsiya uchun profillar local temp/opencode ichida saqlanadi.

Oddiy `npm start`ni local-backup launcher deb qabul qilmang: Electron API manzilining
default’i production. Diagnostikada loopback URL va isolated profilni aniq belgilang.

## Phase 2 — arxitektura, biznes qoidalari va real integratsiya

### A. Legacy arxiv blockerining haqiqiy sababi va tor compatibility yo‘li

`inspect-legacy-archives.cjs` faqat read-only transaction ichida ishlaydi. Ikkala
original archive digest valid. Barcha 1 974 snapshot ticketining canonical ID,
model, partiya raqami, soni, submitted timestampi, statusi va ishchi/tarif entrylari
mos. Yetishmagan 93 + 618 ta `partyRecordId` canonical jadvalda ham NULL: bu
yo‘qotilgan partiya linkini taxminan tiklash holati emas, eski unprinted work.

Oldingi validator `partyRecordId`ni har doim non-null talab qilgan. Endi faqat
ikki tomonda ham partiya yo‘q bo‘lsa, o‘sha tenant/davrda retained closed ticket
hamda model, partiya raqami, patta, qty, timestamp, CONFIRMED/VOIDED status va
entry multiset (operation, worker, rateSnapshot, brak) mosligi bilan membership
tasdiqlanadi. Duplicate entrylar yo‘qolib ketmasligi uchun multiset solishtiriladi.
Biror dalil yo‘q yoki farqli bo‘lsa eski fail-closed natija saqlanadi.

Arxivga `periodId` yoki `partyRecordId` yozilmaydi. Asl JSON o‘zgarmaydi, faqat
alohida `archiveTicketFacts` o‘qish dalili qaytariladi. Noma’lum rate NULLligicha,
VOIDED ticket bekor qilingan holicha qoladi. Tenant/hash/davri noto‘g‘ri bo‘lgan,
ochiq ticket, vaqt/ishchi/tarif farqi va conflicting duplicate regressionlari bor.

133 ta eski size va 136 ta color qiymati mutable canonical satrlardan farq qiladi.
Ular membership dalili sifatida ishlatilmaydi va canonical qiymatlar bilan
almashtirilmaydi; snapshotning original ko‘rinishi saqlanadi.

Haqiqiy Electron `PeriodArchiveRead` ikkala original arxivni ochdi. Accounting
haligacha `HISTORICAL_BASELINE_UNVERIFIED`ni bildiradi: o‘qish imkoniyati tarixiy
balans to‘liq tasdiqlanganini anglatmaydi. IPC’dagi `unresolvedTicketIds` endi
barcha periodId’siz ticketlarni emas, aynan matchingdan o‘tmagan ticketlarni sanaydi.

### B. Joriy admin HTML/JS orqali financial acceptance

Eski VM boot-string rewrite, fake DOM, fake Web Locks va olib tashlangan
`submitQuickAdjustment` funksiyasiga bog‘liqlik chiqarildi. Yangi
`admin-financial-ui*.cjs` haqiqiy admin HTML, autentifikatsiya, DOM eventlari,
Chromium localStorage/Web Locks, signed HTTP route va disposable PG bilan ishlaydi.
Faqat Telegram transporti lokal initData fixture va HTTP fault gateway bilan ajratilgan.

Mustaqil hisob: 2 dona × 13 = 26; AVANS 3, 2, 5 dan keyin net 23, 21, 16.
Bir upstream write commitidan keyin gateway 503 qaytaradi: eski natija noma’lum
bo‘ladi, tab yopilib yangi tab ochiladi. Reconnect aynan oldingi body, revision,
operation/command/adjustment IDlarini yuboradi. Parallel tablar orasida qaysi biri
Web Lockni birinchi olishi taxmin qilinmaydi; biri replayni yakunlaydi, ikkinchisi
completed marker orqali to‘xtaydi. 4 HTTP worker PUT, 3 distinct moliyaviy fact.
Bu haqiqiy Telegram yoki real reverse-proxy sinovi emas.

Shu acceptance invalid amount, double-click, completed-intentli stale tab,
kechiktirilgan eski davr javobi va NULL/0 tariff farqini ham tekshiradi. API orqali
cross-tenant writes, revoked sessions, davr yopish va frozen closing tariff
tekshiruvlari saqlanib qoldi; olib tashlangan Quick Adjustment UI mavjud deb
ko‘rsatilmaydi.

### C. Yangi tasdiqlangan biznes/integratsiya nuqsonlari

1. **Unknown tarif 0ga aylantirilishi.** UI save va API `Number(null)`/bo‘sh string
   orqali noma’lum qiymatni haqiqiy nol tarifga aylantirgan. UI noma’lum maydonni
   bo‘sh, explicit 0ni `0` ko‘rsatadi; bo‘sh input NULL bo‘ladi. Barcha majburiy
   tariflar aniq kiritilmaguncha save rad etiladi. API ham null/undefined/blank/
   boolean/object/arrayni narx deb qabul qilmaydi. Bu nullni qabul qilish uchun
   UpsertModel validationini yumshatish emas. DOM regression known narxni edit
   qilib unknownni tasodifan saqlamaydi; explicit 0 kiritilgandan so‘nggina write.

2. **Unposted AVANS/JARIMA hisobga kirgan.** Server querysi bu turlarni statusga
   qaramay SUM qilgan; SQLite faqat POSTED ishlatgan. Server ham POSTED ledger
   factlarini tanlaydi. Haqiqiy signed-route fixture’da 1 000lik VOIDED AVANS
   26lik ish haqini o‘zgartirmaydi; VOIDED yozuv o‘chirilmaydi yoki qayta yozilmaydi.

3. **Eski async davr javobi yangi holatni bosib ketgan.** Admin loaderida request
   generation, session/actor/company/period ownership tekshiruvi bo‘lmagan.
   Endi faqat joriy request holatni va xabarni yangilaydi. Unit test Q javobidan
   keyin Pni yetkazadi; DOM acceptance eski Q payroll javobini ushlab turib Rga
   o‘tadi, so‘ng Qni chiqaradi: Rning 16lik natijasi saqlanadi.

4. **Custom razmer rename dialogiga kirish yo‘li uzilgan.** PattaBatchView’da
   mavjud rename state/modal bor, ammo uni ochuvchi control yo‘q edi. Mavjud
   guarded rename yo‘liga accessible custom-size button qaytarildi; model-local
   count/name persistence va boshqa modelga tegmaslik actual DOM’da tekshiriladi.

### D. Mustaqil hisob va uzilish/restart dalillari

`payroll-oracle.cjs` production reducer yoki payroll helper import qilmaydi.
Raw SQL GROUP BY va to‘g‘ridan-to‘g‘ri arithmetic asosida 222 ishchi × 3 davr ×
9 maydon × server/desktop = **11 988** tekshiruv. Current-period current tariff,
closed-period frozen closing tariff semantikasi saqlandi; original entry rate
snapshots alohida ticket edit/reassignment oqimida tekshirildi.

Bu oracle resolved/reversal production adjustment paydo bo‘lsa ochiq xato bilan
to‘xtaydi — uni indamay chetlab o‘tmaydi. Backupdagi 216 adjustment UNRESOLVED,
ularning davrini/tarifini taxminan bog‘lamaydi. Synthetic resolved corrections va
reversal golden-case regressiyalari alohida existing suite’da qolgan. Bu mustaqil
external buxgalteriya certificationi yoki historical opening balance isboti emas.

`novda_audit_phase2_verified` original backupdan yangi restore qilindi va 29ga
migratsiya qilindi. Acceptance ikki haqiqiy Electron jarayonini aynan bir isolated
profil bilan ishga tushiradi: birinchisi offline AVANSni SQLite/outboxga commit
qilib chiqadi; ikkinchisi startup/reconnect/replay orqali aynan bir marta yuboradi.
Keyin yana HTTP uzilishi, renderer `initStore` rehydrationi va takroriy reconnect
sinovdan o‘tadi. Ticket create/edit/delete, rate snapshot, Oklad DOM input va oy
yopish oqimlari ham shu nusxada bajariladi.

Davr yopilgach original ikki archive SHA reference bilan tengligi qayta tekshirildi.
29 migratsiya, 17 required FK valid, barcha 16 orphan hisoblagich 0; scope saqlangan.

### E. Static analysis va chiqarilgan texnik qarz

- ESLint correctness gate JS/CJS kodlari uchun `npm run lint` va `npm run verify`ga
  qo‘shildi. TS7 uchun tsc saqlangan: hozirgi typescript-eslint TS <6.1 talab qiladi,
  unsupported parserni force-install qilish yoki TypeScriptni downgrade qilish bajarilmadi.
- Worker service’dagi duplicate export chiqarildi.
- Payroll render launcherining parent branchiga noto‘g‘ri nusxalangan 167 qatordan
  iborat unreachable model-size acceptance bloklari chiqarildi; amaldagi alohida
  `model-sizes-stage-c-runtime.cjs` saqlandi.
- Filters evidence’dagi mavjud bo‘lmagan `journalMismatch` reference chiqarildi.
- Electron fixture failure endi native `app.exit(1)` bilan uzatiladi; parent stage
  completion markerini ham talab qiladi. Avval stack trace bo‘lsa ham exit 0 bo‘lishi
  mumkin edi. Stage C endi eski unrelated payroll bootidan emas, o‘z entrypointidan
  ochiladi va current CSS/control selectorlarini ishlatadi.
- Model-owned size definitions fallback scale toggle’dan ustun: test default numeric
  ro‘yxatini majburlash o‘rniga explicit model names/counts buzilmasligini tekshiradi.
  Bu qoida o‘zgartirilmadi va production kod testga moslashtirilmagan.
- Fastify/fast-uri va bir nechta development transitive dependencylariga faqat
  semver-compatible security yangilanishlar qo‘llandi; majburiy major downgrade yoki
  `npm audit fix --force` bajarilmadi.
- Dependency auditda Electron 44.0.0 uchun ham high advisory borligi aniqlandi:
  npm’da devDependency bo‘lsa-da, bu shipped runtime. Electron hamda builder runtime
  pin birga 44.10.2ga ko‘tarildi. Test/build tool patchlari ham compatible diapazonda
  yangilandi. Yakuniy audit: production dependencylar 0 advisory; barcha dependencylar
  bo‘yicha 9 moderate qolgan, high/critical yo‘q. Qolgan tooling/packager advisorylari
  force downgrade bilan yashirilmagan; installer build/upgrade alohida release gate.

### F. Phase 2 sign-off chegarasi

Priority 1 blockerlar uchun dalilli fix va end-to-end dalil bor. Butun ilova uchun
yakuniy production sign-off hali berilmaydi. 216 historical adjustment attributioni
va opening balance noaniqligi saqlanadi; ularni nol yoki aniqlangan deb ko‘rsatish yo‘q.
Physical printer, haqiqiy Telegram, production signing/TLS, installer upgrade,
katta yuklama va barcha uzoq muddatli multi-device race holatlari tasdiqlanmagan.
Eski universal render harnessining har bir flagi qayta sertifikatlanmagan.

### G. Yakuniy qayta tekshiruv natijalari

Yakuniy runtime: Electron **44.10.2**, Vite **8.3.7**, Vitest **5.1.0**,
Fastify **5.12.8**. Runtime pin va native SQLite bilan actual Electron acceptance
qayta bajarildi; faqat package metadata yangilangan deb hisoblanmadi.

- `npm run verify`: ESLint, protected-file integrity, TypeScript, production build;
  **83 test fayli, 737 test PASS, 1 oldingi skip**.
- Yangi disposable `hisob_test_phase2_final`dagi PG suite:
  **37 test fayli PASS, 367 test PASS**, opt-in backup drill avvalgidek skipped.
- Python: **37 test, 176 subtest PASS**.
- `novda_audit_phase2_releaseproof`: original dumpdan alohida yangi restore,
  **11 988 mustaqil payroll tekshiruvi**; haqiqiy ikki Electron process restart,
  offline HTTP/replay, ikkala legacy archive, ticket/worker/Oklad/month close PASS.
  Boshidagi biznes qatorlari original 28 / 222 / 1 976 / 28 700 / 2 ga mos.
- `hisob_test_bot8b1_phasetwoi`: worker bot/signed API/admin writes va actual admin
  financial DOM acceptance to‘liq PASS. 26 → 23 → 21 → 16, lost response replay,
  concurrent/stale tabs, old-period response va unknown/zero tariff tekshirildi.
- `MODEL_SIZES_C_ONLY=1 node scripts/verify/render/payroll-display-runtime.cjs`:
  **MODEL_SIZES_C_PASS**, runtime 44.10.2. Actual App → model-local add/rename/delete
  guard → SQLite save/reopen → preview/generated HTML → CompletePattaBatch outbox.
  4 patta, sonlar 1–4, ish jami 50 = 3×10 + 1×20; modellar aralashmagan.
  Bu fixture’da outbox PENDING qolishi kutiladi: PG print acceptance yoki physical
  printer sinovi deb berilmaydi. Preview va HTML tarkibi alohida solishtirilgan.
- `npm run verify:secrets`: PASS. Production dependency audit: 0 advisory.
  To‘liq dependency audit **PASS emas**: 9 moderate tooling/packager advisorysi qolgan.
  High/critical yo‘q, lekin bu dependency riskini to‘liq yo‘q deb bo‘lmaydi.
- Asl dump va reference baza saqlangan. Yangi restore va yangi test bazalaridan
  tashqarida destructive test/reset bajarilmadi. Production ulanish/push/deploy yo‘q.

Regressionlarni qayta bajarish uchun yuqoridagi Phase 1 commandlari o‘sha-o‘sha;
faqat yangi disposable audit DB ishlating. Phase 2 read-only archive diagnostikasi:

```text
node scripts/verify/database/inspect-legacy-archives.cjs
```

`NOVDA_AUDIT_PG_URL` bu diagnostikada faqat loopback local_current yoki audit nusxa
bo‘lishi mumkin; diagnostika READ ONLY transaction ishlatadi, credential va to‘liq
archive/person ma’lumotini log qilmaydi. Standalone bot/admin acceptance uchun
`NOVDA_LOCAL_TEST_PG_URL` yangi `hisob_test_bot8b1_<letters>` bazaga aniq belgilanadi.
