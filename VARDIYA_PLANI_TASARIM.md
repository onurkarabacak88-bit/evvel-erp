# 🗓️ EVVEL YENİ · VARDİYA PLANI — Tasarım (kod yazılmadı) · Sürüm 1

> Fable · 2026-10-18. Sahip kararı: "olmalı mı" madde 36 = **TAŞI**, "düzgün şekilde Fable'a sorarak kur" (YOKLAMA_QR_TASARIM §F2/F8).
> Eski sistem incelendi: `database.py` :4613-5011 (vardiya_slot, vardiya_preset, personel_kisit, vardiya_atama, personel_izin, override_log, gun_niyet, gun_kilit, sube_gun_hedef — **9 tablo**), `vardiya_v2.py` (2.996 satır motor: `atama_uyarilari` :1538, `gun_kopyala` :2123, `personel_ay_vardiya_maas_kaynagi` :2895), `vardiya_plan_motor.py` (haftalık otomatik motor), `gorev_api.py` (`vardiya_takip` :1970-2400: fazla mesai = `max(0, günlük plan saati − 9,5)`; `gorev_personel_vardiya` :104), `src/pages/VardiyaPlanlamaV2.jsx` (5.339 satır: sürükle-bırak, esnek mod, otomatik doldur, PIN'li geçmiş kilidi), `memory/reference_vardiya_planlama.md`.
> EY tarafı: `evvel_yeni_maas_api.py` (`_vardiya_onerisi` :88-103, `hesapla` :196/:243/:256, `gunluk_yoklama` :622-716, `personel_takvim` :418), `MaasModulu.jsx` (:150, :306), `evvel_yeni_panel_api.py` (`durum` :257), `evvel_yeni_cekirdek.py` (`ayar_oku` :160, `bekleyen_is_kaydet` :180), `evvel_yeni_moduller.py` (`DURUM` :62), `evvel_yeni_tanim_api.py` (bir-kez-kopya örüntüsü :101-108).
> Kural: sıfırdan, EY içinde, **yeni tak-çıkar modül `vardiya`**; eski `vardiya_atama` / `vardiya_slot` / `gorev_api` tablolarına köprü YOK (içerik bir kez kopyalanır, §B6). Uyarı personele gitmez. Kimlik = `ey_personel.id` / `ey_sube.id`. Yetki en sonda.

---

## A. SAHİP BÖLÜMÜ (1 sayfa)

### A1. Eski → yeni — ne sadeleşiyor

| Konu | Eski (vardiya_v2 + gorev_api) | Yeni (EY `vardiya` modülü) | Kazanç |
|---|---|---|---|
| Yapı | 9 tablo: slot (çerçeve) + preset (saat kalıbı) + kişi kısıtı + atama + izin + override + niyet + gün kilidi + hedef | **2 tablo**: **Kalıp** (şube × "Sabah 09:00–18:30 · 1 kişi") + **Plan** (kişi × gün × şube × saat) | Kadro tek yerde yazılır: "Alsancak = 1 tam + 1 part" = 2 kalıp satırı |
| Planlama | Sürükle-bırak, 8 tür uyarı, "esnek mod" anahtarı (herkes açık tutuyordu), otomatik doldur, haftalık motor | Haftalık ızgara: şube → kalıp satırı → gün hücresine **kişi seç**; saat kalıptan gelir, istenirse değiştirilir. **"Geçen haftayı kopyala"** tek düğme. Tek engel: **aynı kişi aynı saatte iki yerde** | 4 şubenin haftası ~5 dakika; motor/kısıt/esnek mod yok |
| Geçmiş kilidi | PIN'li hafta kilidi | Kilit yok; her değişiklik **izli** (kim, ne zaman, eski → yeni); gün geçtikten sonra yazılan plan "sonradan" damgalı | Sadelik + iz |
| Günlük yoklama "zamanında / geç" | Eski `vardiya_atama` × eski `gorev_yoklama` (1 Kasım'da kopar) | **Plan × yeni QR** (`ey_yoklama`), tolerans ayarlanır (öneri **10 dk**); QR yok ama panel izi var → "panelde göründü" (çalıştı, F1a); müdür → "müdür" (F1b) | Mevcut sayfa aynı, kaynağı değişir — ikinci okuyucu yok |
| Maaş "mesai saati önerisi" | `gorev_api.vardiya_takip` (plan bazlı) | Aynı kural, yeni plandan: **mesai = Σ max(0, günün plan saati − 9,5)**; yarı zamanlı **çalışma saati = Σ plan saati**. Yanında **QR gerçek saati** bilgi olarak; elle giriş öneriyi ezer (mevcut) | Haftalık 57 saat limiti ve kısıt tabloları kalkar |
| Panel / telefon | Panel vardiya planını görev bölüşümü için okuyordu | Panel ana sayfada **"Bugün: Ayşe 09–18:30 · Mehmet 14:30–23:59"** satırı; telefonda "Bugün: Zafer 09:00–18:30" (bilgi, uyarı değil) — isteğe bağlı faz | Kim ne zaman gelecek paneldekilerce görünür |
| İzin | Ayrı izin tablosu (yıllık/mazeret/rapor/ücretsiz, yarım gün) | **Ayrı izin defteri yok**: planda olmayan gün = boş gün. Yıllık izin mevcut "takvim kararı"ndan (Personel takvimi sorusu) okunur, planda gri | Karışıklık varsa kaldır; rapor/eksik gün maaşta elle (mevcut) |
| Uyarılar | Planlama ekranında 8 tür blok/uyarı | Yalnız merkez **Bekleyen işler › Personel**: plan yok · kalıp eksik · planlı gün gelmedi · plansız çalıştı | Personele gitmez; merkez tek tıkla çözer |

### A2. Merkez ekranı — Personel › **Vardiya planı** (yeni menü yok)

| Bölge | Ne |
|---|---|
| Üst | ◀ Hafta ▶ (Pzt–Paz) · **Geçen haftayı kopyala** · Kalıpları düzenle · Görünüm: Şube / Kişi · Tolerans (dk) |
| Izgara (Şube görünümü) | Satır = şube › kalıp ("Sabah 09:00–18:30 · 1 kişi"); sütun = 7 gün; hücre = kişi yongası (saat farklıysa yanında). Boş hücre amber çerçeve (kalıp eksik). Tıkla → kişi listesi (önce o şubeye kayıtlı, sonra diğerleri; aynı saatte başka yerde olan gri "çakışır"). Yonga tıkla → saat değiştir / kaldır |
| Izgara (Kişi görünümü) | Satır = kişi; hücre = "Zafer 09–18:30"; altta hafta toplamı saat | 
| Alt | Şube başına haftalık toplam saat · kişi başına toplam saat · "sonradan yazıldı" işaretleri |
| Kalıplar (küçük pencere) | Şube seç → satır ekle: ad, başlangıç, bitiş, gece mi, kaç kişi, hangi günler (Pzt…Paz). Örnek Alsancak: "Tam gün 09:00–18:30 · 1 kişi · her gün" + "Akşam part 18:30–23:59 · 1 kişi · her gün" |

Hafta planlama akışı: **Geçen haftayı kopyala** → değişen 2-3 hücreyi düzelt → bitti. İlk hafta: eski sistemin kalıpları ve 27 Ekim–2 Kasım atamaları bir kez kopyalanır (§B6), elle başlanmaz.

### A3. Takvim (1 Kasım şartı DEĞİL — ama ilk hafta planı 31 Ekim'de girili olmalı ki Günlük yoklama 1 Kasım'dan "geç" diyebilsin)

| Faz | İş | Hedef |
|---|---|---|
| V0 | `vardiya` modülü: kalıp + plan tabloları, PUBLIC servisler, haftalık ekran, kopyala, eski içerik bir kez kopya | 24–26 Ekim (B4 Y0 bitince) |
| V1 | Okuyucular kaynak değiştirir: Günlük yoklama plan sütunu + maaş öneri + Bekleyen işler 4 satır + MaasModulu metinleri | 27–29 Ekim (Y1 ile birlikte) |
| V2 | Panel "Bugün" satırı + telefon "Bugün" satırı (bilgi) | Kasım ilk hafta |
| Kesim | Eski `vardiya_atama/slot/preset/kisit/izin/override/niyet/kilit/hedef` + `vardiya_v2.py` + `vardiya_plan_motor.py` + `VardiyaPlanlamaV2.jsx` + `PersonelVardiyaTakip.jsx` + `gorev_api.vardiya_takip` sökümü | Aralık (E söküm) |

### A4. Sahibin vereceği kararlar

| # | Soru | Öneri |
|---|---|---|
| V1 | Geç kalma toleransı: bugün 5 dk kodda sabit | **10 dk**, Vardiya planı sayfasından değiştirilir (ayar) |
| V2 | Mesai / çalışma saati önerisi **plandan** (eski gibi); QR gerçek saati yanında bilgi; fark büyükse Bekleyen iş değil, maaş satırında gösterilir | **Evet** — plan esas, QR bilgi (çıkışı unutan kişi QR'ı bozabilir) |
| V3 | Günlük fazla mesai eşiği 9,5 saat (maaş kuralıyla aynı); haftalık 57 saat limiti ve kişi kısıtları **kalkar** | **Evet** |
| V4 | Planlı gün QR/panel izi yok → **otomatik eksik gün YAZILMAZ**; Bekleyen iş'te merkez tek tıkla "Eksik gün yaz / İzinli / Gördüm" | **Evet** (kanıtsız kesinti yok) |
| V5 | Eski sistemden bir kez kopya: 4 şubenin slotları → kalıp; 27 Ekim–2 Kasım haftası atamaları → plan | **Evet** (boş başlamaktan 1 saat kazanç) |
| V6 | Panel ve telefonda "Bugün" satırı (bilgi; uyarı değil) | **Evet**, V2 fazında |
| V7 | Kişi başına "sabit düzen" (her hafta aynı) kurulmasın; "Geçen haftayı kopyala" yeter | **Kurulmasın** |
| V8 | Geçmiş gün planı değiştirilebilir (PIN yok), izli + "sonradan" damgalı | **Evet** |
| V9 | Zamanlama: V0+V1 1 Kasım'dan önce (B4–B6 yüküne rağmen) mi, Kasım ilk haftası mı? | **1 Kasım'dan önce** — plan yoksa Kasım'ın ilk haftası "geç" ölçülemez |
| V10 | Ayrı izin defteri yok; yıllık izin mevcut takvim kararından; rapor maaşta elle | **Evet** |

---

## B. TEKNİK EK

### B1. İlişki haritası — bu iş hangi alanlara dokunuyor (kayıp olmama kuralı 1)

| Alan | Dokunuş | Yön |
|---|---|---|
| `maas` (evvel_yeni_maas_api) | `_vardiya_onerisi` :88 kaynak değişir · `gunluk_yoklama` :622 plan kaynağı değişir · `hesapla` :243/:256 etiket "(vardiya planı)" aynen | vardiya → maas (PUBLIC) |
| `yoklama` (B4–B6, YOKLAMA_QR_TASARIM) | Günlük yoklama QR tarafı `gun_yoklama` (F2); telefon `ben` cevabına `bugun_vardiya` (V2) | yoklama ↔ vardiya |
| `panel` (evvel_yeni_panel_api) | `durum` cevabına `bugun_plani` (V2, bilgi) | vardiya → panel |
| `olay` (ey_sube_olay) | Panel izi okunur (F1a: QR'sız çalıştı); plan değişikliği izi **kendi tablosunda** (B3), olay defterine yazılmaz (şube olayı değil, merkez kararı) | olay → vardiya (okuma) |
| `tanim` (ey_personel / ey_sube) | Kimlik kaynağı; `calisma_turu` (tam/yarı), B7 **müdür işareti** (`ey_personel.mudur`) ve `cikis` okunur; şube aktifliği | tanim → vardiya |
| Çekirdek | `ey_ayar` (`vardiya_gec_tolerans_dk`, `vardiya_gunluk_saat`, `vardiya_kopya`), `bekleyen_is_kaydet("vardiya", …)`, `aktor`, `bugun` | çekirdek → vardiya |
| Bekleyen işler (KasaModulu `IS_GRUPLARI` personel grubu) | Grup adı "Avans · Yoklama · Vardiya"; 4 satır türü (B8) — yeni grup yok | vardiya → kabuk |
| Manifest | `evvel_yeni_moduller.MODULLER` + `moduller.jsx` birer satır; `bolum:'maas'` (sayfa Personel altında) | — |
| Eski sistem (sökülecek) | `gorev_api.vardiya_takip` / `gorev_personel_vardiya` / `vardiya-atama-incele`, `vardiya_v2.py`, `vardiya_plan_motor.py`, `duyu_gorunumler` B43 vardiya-takvimi, `whatsapp_bildirim`, `personel_puan_api`, `maas_service`/`ucret_api` bordro — hepsi eski Evvel; EY'den **hiçbiri çağrılmaz** | KESIM 17 |
| Ad çakışması (anlam) | Olay defterinde `tur='vardiya'` = **kasa devri** (panel). Bu modül **plan**; olay türü değişmez, belgede "vardiya devri" ≠ "vardiya planı" | — |

### B2. "Var olan okumadan devam" — mevcut okuyucular, kaynak değişimi (kural 2; ikinci okuyucu YOK)

| # | Okuyucu | Bugün okuduğu | Yeni kaynağı |
|---|---|---|---|
| R1 | maas `_vardiya_onerisi(ay)` :88-103 → `hesapla` :196 (`oneri[pid]` → `mesai_saat`, `calisma_saat`, `planli_gun`) | `gorev_api.vardiya_takip` (eski tablolar) | `DURUM["vardiya"]=="yuklendi"` ise `vardiya.ay_ozet(cur, ay)`; değilse `{}` + uyarı "vardiya modülü kapalı — saatler elle". Aynı sözlük biçimi (`mesai_saat`, `calisma_saat`, `planli_gun`) + yeni `qr_saat` (bilgi) |
| R2 | maas `gunluk_yoklama` :641-648 (plan) | `vardiya_atama JOIN vardiya_slot` | `vardiya.gun_plani(cur, bas, son)`; satır biçimi aynı (`tarih, pid, sid, baslangic_saat, bitis_saat, slot`→`kalip`) |
| R3 | maas `gunluk_yoklama` :649-658 (QR) | eski `gorev_yoklama` | zaten F2: `yoklama.gun_yoklama` (1 Kasım'dan) — bu tasarım dokunmaz |
| R4 | maas `gunluk_yoklama` `GEC_TOLERANS_DK` :619 sabit 5 | kod sabiti | `ayar_oku(cur,"vardiya_gec_tolerans_dk","10")` — tek yer |
| R5 | `MaasModulu.jsx` :150 "şube panelinin vardiya planı kullanılır" · :306 "vardiya planı girilmemiş" | metin | "Personel › Vardiya planı kullanılır" · aynı (`plan_var` yeni kaynaktan) |
| R6 | maas `personel_takvim` :418 | QR + panel izi (plan okumuyor) | **Değişmez** — plan hücreye eklenmez (gün görünümü Günlük yoklama'da) |
| R7 | panel `durum` :257 | plan okumuyor | V2: `bugun_plani` alanı (yeni okuma değil, PUBLIC servis çağrısı; modül kapalıysa alan yok) |
| R8 | telefon `ben` (yoklama B7) | — | V2: `bugun_vardiya` tek satır |
| R9 | eski `gorev_api.gorev_personel_vardiya` :104 (görev bölüşümü plandan) | eski | **Taşınmaz** — görev listesi B8 telefon sayfası kurgusunda ayrıca karar (D37) |

### B3. Veri modeli (hepsi `ey_` ön ekli; eski tabloya FK yok; silme yok)

| Tablo | Sütunlar | Kurallar |
|---|---|---|
| `ey_vardiya_kalip` | `id TEXT PK`, `sube_id` (ey_sube), `ad` ("Sabah", "Akşam part", "Tam gün"), `bas TIME`, `bit TIME`, `gece BOOL DEFAULT FALSE` (bit ertesi gün), `kisi INT DEFAULT 1` (hedef kişi), `gunler INT[] DEFAULT '{1..7}'`, `sira INT`, `aktif BOOL`, `degistiren`, `zaman` | Kadro = kalıp satırları. Pasife alınır, silinmez; plan satırı `kalip_id` SET NULL değil — saatler planda kopyalı durur (eski "slot silinince atama kaybolmasın" dersi, database.py :4893) |
| `ey_vardiya_plan` | `id TEXT PK`, `sube_id`, `personel_id` (ey_personel), `gun DATE`, `bas TIME`, `bit TIME`, `gece BOOL`, `kalip_id` (nullable), `kaynak` ('elle' / 'kopya' / 'eski_kopya' / 'sonradan'), `iptal BOOL DEFAULT FALSE`, `iptal_neden`, `onceki_id` (değişiklikte eskinin id'si), `degistiren`, `zaman` | **Append-only**: saat değişikliği = eski satır `iptal=TRUE` + yeni satır `onceki_id` → iz. Gün geçtikten sonra yazılan → `kaynak='sonradan'`. Kısmi UNIQUE `(personel_id, gun, sube_id, bas) WHERE NOT iptal`. Aynı kişi aynı gün iki şube **serbest** (split shift, eski ders), **saat çakışması 409** (`araliklar_cakisir`, gece +1440 dk). İndeks `(gun, sube_id) WHERE NOT iptal`, `(personel_id, gun) WHERE NOT iptal` |
| `ey_ayar` (+3) | `vardiya_gec_tolerans_dk` (10), `vardiya_gunluk_saat` (9.5 — maas `GUNLUK_SAAT` ile aynı değer; tek yerden okunması için maas da ayarı okur), `vardiya_kopya` (bir kez kopya bayrağı) | mevcut ayar defteri |
| `ey_personel` (+1, B7 ile birlikte) | `mudur BOOL DEFAULT FALSE` | F1b; takvimde `"MÜDÜR" in gorev` metin aramasının yerine geçer (B7'de) |

Saat hesabı tek yardımcı: `sure_saat(bas, bit, gece)` (gece ise +24 s). "Plan saati" = Σ sure_saat kişi × gün.

### B4. Modül: `vardiya` (tak-çıkar, kural 6)

- Manifest: `{"kod":"vardiya","ad":"Vardiya planı","ikon":"🗓️","sektor":"genel","gerekir":["tanim"],"menu":False,"aciklama":"haftalık kalıp + kişi/gün planı; Günlük yoklama (zamanında/geç), Maaş (mesai önerisi), Panel/Telefon 'bugün' buradan okur (sayfası Personel altında)"}`. `maas`, `yoklama`, `panel` bu modülü **gerektirmez**: `evvel_yeni_moduller.DURUM.get("vardiya") == "yuklendi"` ise PUBLIC servisi çağırır, değilse plansız çalışır (Günlük yoklama = girdi/girmedi; maaş öneri boş + uyarı). `vardiya` yoklamayı gerektirmez (plan QR'sız da girilir); Günlük yoklama'daki birleştirme maaş modülünde kalır (mevcut okuyucu).
- Dosya `evvel_yeni_vardiya_api.py`, `router prefix=/api/evvel-yeni/vardiya`; `vardiya_hazirla(cur)` (`lock_timeout 3s`, `CREATE TABLE IF NOT EXISTS`, bir-kez-kopya §B6). Ön yüz `src/pages/evvelyeni/VardiyaModulu.jsx`; `moduller.jsx`'e `{ mod:'vardiya', bolum:'maas', sayfalar:[{id:'vardiya_plani', ad:'Vardiya planı', alt:'Hafta hafta kim nerede kaçta'}] }` (Avans örüntüsü).
- PUBLIC servisler (başka modül yalnız bunları çağırır; `_` fonksiyon dışarı çıkmaz):

| Servis | Döndürdüğü |
|---|---|
| `gun_plani(cur, bas, son, sube_id=None) -> [ {gun, personel_id, sube_id, bas, bit, gece, kalip, kaynak} ]` | iptal olmayan plan satırları (R2, R7) |
| `kisi_bugun(cur, personel_id, gun) -> [ {sube_id, sube, bas, bit} ]` | telefon `ben` (R8) |
| `ay_ozet(cur, ay) -> {pid: {planli_gun, calisma_saat, mesai_saat, gunler:[{gun, saat, mesai}]}}` | R1; `mesai = Σ max(0, gün_saat − vardiya_gunluk_saat)`; aynı gün iki şube **toplanır** (eski FIX M2 dersi); kişinin `giris`/`cikis` dışındaki günler sayılmaz; `mudur` → `mesai_saat=0` (F1b, elle girilebilir) |
| `hafta_ozet(cur, pazartesi) -> {sube: {kalip: {gun: [kişi…]}}, kisi: {gun: saat}}` | ekran |
| `kalip_eksikleri(cur, bas, son) -> [ {sube_id, gun, kalip, hedef, atanan} ]` | Bekleyen iş |

- Uçlar (`x_evvel_oturum`): `GET /hafta?pazartesi=` · `POST /plan {sube_id, personel_id, gun, bas, bit, gece, kalip_id}` (çakışma → 409 `cakisma|Ayşe o saatte Köyceğiz'de`) · `POST /plan/{id}/degistir {bas, bit}` (iptal + yeni, `onceki_id`) · `POST /plan/{id}/iptal {neden}` · `POST /hafta-kopyala {kaynak_pazartesi, hedef_pazartesi, ustune_yaz:false}` (hedef haftada o kişi-gün-şube doluysa atlar; `kaynak='kopya'`; sayı döner "18 satır kopyalandı, 2 atlandı") · `GET/POST /kalip` · `POST /kalip/{id}/degistir` · `GET /ayar` · `POST /ayar {gec_tolerans_dk}` (ayar_yaz, iz `degistiren`).

### B5. Günlük yoklama — zamanında / geç hesabı (maas `gunluk_yoklama` içinde, kaynak değişir)

| Adım | Kural |
|---|---|
| Plan | `vardiya.gun_plani(bas, son)`; modül kapalı → `plan=[]`, `plan_var=False` (bugünkü davranış) |
| Gerçek | `yoklama.gun_yoklama` (ey_yoklama giriş/çıkış) + **panel izi** `ey_sube_olay` (`personel_id`, o gün o şube; F1a) |
| Eşleme | Plan satırı sırayla (bas'a göre); aynı kişi + aynı şube ilk kullanılmamış giriş; yoksa başka şubedeki girişi (göster: "Köyceğiz'de okuttu") |
| Durum | `zamaninda`: giriş ≤ plan bas + tolerans · `gec`: fark dk · `erken_cikti` bilgi: çıkış < plan bit − tolerans (dk) · `okutmadi`: gün/başlangıç geçti, QR yok, panel izi yok · `panel_izi`: QR yok, panel izi var (çalıştı; saat "—", geç hesaplanmaz) · `mudur`: `ey_personel.mudur` ve QR yok (ölçülmez) · `bekleniyor`: bugün, başlangıç gelmedi · `plansiz`: QR var, plan yok |
| Tolerans | `ayar_oku("vardiya_gec_tolerans_dk", "10")`; cevapta `tolerans_dk` (ekran yazısı mevcut) |
| İş günü | plan `gun` = iş günü (`cekirdek.is_gunu`); gece kalıbı (bit ertesi gün) aynı iş gününde |

Personel sayfasında/panelde bu durumlar **gösterilmez**.

### B6. Eski içeriğin BİR KEZ kopyası (köprü değil; `vardiya_hazirla` içinde, ayar `vardiya_kopya` yoksa)

| Eski | Yeni | Not |
|---|---|---|
| `vardiya_slot` (aktif, 4 şube) | `ey_vardiya_kalip`: `ad`, `bas=baslangic_saat`, `bit=bitis_saat`, `gece=gece_vardiyasi`, `kisi=ideal_personel`, `gunler=aktif_gunler`, `sira`, `degistiren='eski sistem kopyası'` | `sube_id` aynı kimlik (ey_sube eski id ile kopyalandı); ey_sube'de olmayan şube atlanır. "Serbest" tipi otomatik slotlar (`_auto_slot_sil`) **atlanır** |
| `vardiya_atama` 27 Ekim–2 Kasım (durum ≠ iptal) | `ey_vardiya_plan`: `kaynak='eski_kopya'`, `kalip_id` = slotun yeni kalıbı (yoksa NULL), saatler atamanın kendi saatleri | `personel_id` aynı kimlik (ey_personel eski id ile); ey_personel'de yoksa atlanır + log. Çakışanlar da kopyalanır (iz "eski_kopya"), ekranda görünür |
| `personel_kisit`, `personel_izin`, `vardiya_override_log`, `gun_niyet`, `gun_kilit`, `sube_gun_hedef`, `vardiya_preset` | — | Kopyalanmaz (karar V3/V10) |

Kopya tek işlemde, `savepoint`, hata → log + bayrak yazılmaz (tekrar denenir). Sonrası: eski tablolar okunmaz; eski ekran (`VardiyaPlanlamaV2`) 1 Kasım'a kadar eski sisteme yazmaya devam edebilir ama EY **onu okumaz** (çift yazım yok — KESIM 17 "vardiya çift yazımı YOK").

### B7. Maaş önerisi — plan × gerçek (R1)

```
o = ay_ozet(cur, ay)[pid]
yarı zamanlı : calisma_saat = o.calisma_saat (plan Σ)      → kalem "Çalışma 88 saat × 150 ₺ (vardiya planı)"   [mevcut :243]
tam zamanlı  : mesai_saat   = o.mesai_saat (Σ günlük aşım) → kalem "Fazla mesai 6 saat (vardiya planı)"       [mevcut :256]
müdür        : mesai_saat   = 0 (F1b) — elle girilirse girilen
bilgi        : ek.qr_saat = yoklama.calisma_saatleri(cur, pid, ay)  (Σ çıkış−giriş; çıkışsız gün sayılmaz) → satırda "QR: 84 s" (plan 88 s)
elle         : ey_maas_ay.mesai_saat / calisma_saat doluysa öneri ezilir (mevcut); onaylı ay dondurulmuş kalemden (mevcut :273)
```
`planli_gun` yemek paydasına **girmez** (K7/K8: yemek paydası QR ile çalışılan gün — yoklama B9). "Gelmedi" günü otomatik eksik gün yapmaz (V4).

### B8. Bekleyen işler sağlayıcısı — `bekleyen_is_kaydet("vardiya", …)`, grup `personel` (Avans · Yoklama · Vardiya); **çözülene kadar kalır**

| tur | Koşul | Satır → düğme → uç |
|---|---|---|
| `plan_yok` | aktif şube, önümüzdeki 7 günde hiç plan satırı yok | "🗓 Zafer 20–26 Ekim planı yok" → "Planla" (sayfaya git) / "Geçen haftayı kopyala" → `hafta-kopyala` |
| `kalip_eksik` | önümüzdeki 3 günde kalıp hedefi < atanan | "👤 Alsancak Çar akşam 0/1" → "Planla" |
| `gelmedi` | plan var, gün geçti, QR yok, panel izi yok, müdür değil, karar yok | "🚫 Ayşe 17.10 Zafer planlıydı — giriş yok" → **Eksik gün yaz** (maas elle ucu `eksik_gun+1`, mevcut) / **İzinli** (`takvim-karar` izin, mevcut) / **Gördüm** (`takvim-karar` devam) — hepsi mevcut uçlar, yeni iz tablosu yok |
| `plansiz_calisti` | QR var, o gün plan yok, görülmedi | "ℹ Mehmet 17.10 Köyceğiz plansız çalıştı" → "Plana işle" (`POST /plan` kaynak 'sonradan', saat QR'dan) / "Gördüm" (`takvim-karar` devam) |

Hiçbiri panele/telefona gitmez.

### B9. Panel / telefon "Bugün" (V2, bilgi)

- Panel `durum` (`evvel_yeni_panel_api` :257): `DURUM["vardiya"]=="yuklendi"` ise `bugun_plani = gun_plani(cur, gun, gun, sube_id)` → ana sayfada tek satır kart "Bugün: Ayşe 09:00–18:30 · Mehmet 14:30–23:59". Personel seçim listesi sırası **değişmez** (liste = bugün QR ile girenler, D4).
- Telefon `ben`: `bugun_vardiya = kisi_bugun(cur, pid, gun)` → "Bugün: Zafer 09:00–18:30" (plan yoksa satır yok). Geç/erken yazılmaz.

### B10. Fazlar — boyut, kabul

| Faz | Boyut | Kabul ölçütü |
|---|---|---|
| V0 | ~350 py + ~450 jsx | 4 şube kalıbı kopyalandı; 27 Ekim haftası ekranda eski planla aynı (kişi × gün × saat sayısı eşit); aynı kişi aynı saatte iki şube → 409; split shift (09–14 Zafer + 15–22 Köyceğiz) kabul; kopyala → "18 kopyalandı, 2 atlandı"; saat değişikliği eski satırı iptal + yeni satır `onceki_id`; geçmiş güne yazılan `sonradan` |
| V1 | ~150 py + ~80 jsx | Günlük yoklama: plan sütunu yeni tablodan, 10 dk tolerans ayardan, panel izi "panelde göründü", müdür ölçülmez; maaş satırı "(vardiya planı)" etiketi yeni kaynaktan, QR saati bilgi; vardiya modülü kapatılınca (`acik=False`) maaş/yoklama çalışır + uyarı; Bekleyen işler 4 satır ve her düğmenin ucu |
| V2 | ~60 py + ~60 jsx | panel ve telefonda satır; plan yoksa görünmez; uyarı yok |

Her faz: `python scripts/kapi_kontrol.py` + Codex + Fable; 23:45–00:15 yayın yok.

### B11. Riskler

| Risk | Karşılık |
|---|---|
| B4–B6 (QR) ile aynı haftaya sıkışır | V0 bağımsız (QR'a bağlı değil); V1 Y1 ile aynı yayında; olmazsa Kasım 1. hafta — Günlük yoklama o haftayı plansız gösterir, maaş öneri elle (V9 sahip) |
| Eski kopyada kimlik eşleşmez | ey_personel/ey_sube eski id'yi taşıyor (tanim :65); eşleşmeyen atlanır + log + Bekleyen iş `plan_yok` zaten uyarır |
| "Sonradan" yazılan planla mesai şişer | satır damgalı, maaş satırında "⚠ 3 gün sonradan planlandı"; onaylı ay dondurulur |
| Çıkışı unutulan QR → gerçek saat düşük | öneri plandan (V2); QR yalnız bilgi; çıkışsız gün yoklama Bekleyen iş'te zaten |
| Gece kalıbı iş günü sınırı | plan `gun` = iş günü; `gece=TRUE` süre +24 s; QR eşlemesi `is_gunu` ile |
| Aynı kişi iki şube aynı gün geç hesabı | her plan satırı ayrı eşlenir; ilk kullanılmamış giriş, şube önceliği |
| Modül kapatıldı | `DURUM` kontrolü; tablolar durur; maaş/yoklama plansız çalışır |
| Olay `tur='vardiya'` (kasa devri) ile ad karışır | belge/kod yorumunda "vardiya devri (kasa) ≠ vardiya planı"; olay türü değişmez |

## C. SAHİP KARARI (2026-10-18)
V1–V10: **Fable'ın önerileri aynen onaylandı** (sahip: "devam et"). Codex görüşü kota açılınca alınacak; çelişki çıkarsa sahibe getirilir.
