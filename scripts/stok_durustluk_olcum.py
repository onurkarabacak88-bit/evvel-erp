# -*- coding: utf-8 -*-
"""📏 STOK DEFTERİ DÜRÜSTLÜK ÖLÇÜMÜ — haftalık çalıştır. SALT OKUMA.

Fable planı adım 7. Tek kural:
    sonraki_miktar - onceki_miktar == miktar   (işaretli)
Bunu bozan satır, deftere GÖRÜNMEYEN bir stok değişimi yazıldığını söyler.

⚠️ KESİM TARİHİ ŞART. "Bulundu doktrini" 2026-09-14'te canlıya alındı
(commit b42f467). Ondan ÖNCEKİ satırlar düzeltilemez — geriye dönük defter
satırı yazmak tarihe satır sokmaktır ve zinciri yeniden koparır. Bu yüzden
ölçüm İKİ BÖLÜM hâlinde raporlanır:
    · KESİMDEN SONRA → düzeltmenin gerçek karnesi. Hedef: 0.
    · KESİMDEN ÖNCE  → dondurulmuş tarih. Azalması BEKLENMEZ.
Tek rakama bakıp "düzelmedi" demek, düzelmiş olanı göremez.

⚠️ SAHTE YEŞİL UYARISI: "karşılıksız 0" tek başına başarı DEĞİLDİR. Doktrin
farkı `SAYIM_DUZELTME` satırına çevirdiği için karşılıksız TANIМ GEREĞİ 0'a
iner. Gerçek ölçüt, `*_bulunan` satırlarının ve "girişi hiç kaydedilmemiş"
kalemlerin ZAMANLA AZALMASIDIR — o da kayıt disiplinini gösterir.

Kullanım:  python scripts/stok_durustluk_olcum.py [--gun 90]
"""
import collections
import datetime
import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

U = "https://evvel-erp-production.up.railway.app/api"
KESIM = datetime.date(2026, 9, 14)          # bulundu doktrini canlıya alındı
GUN = 90
if "--gun" in sys.argv:
    try:
        GUN = int(sys.argv[sys.argv.index("--gun") + 1])
    except (IndexError, ValueError):
        pass


def g(yol, t=180):
    r = urllib.request.Request(U + yol, headers={"Accept": "application/json"})
    return json.loads(urllib.request.urlopen(r, timeout=t).read().decode("utf-8"))


LIMIT = 2000   # ucun tavani


def _liste(d):
    s = d.get("hareketler") or d.get("satirlar") or []
    if not s and isinstance(d, dict):
        for v in d.values():
            if isinstance(v, list) and v:
                return v
    return s


def hareketler():
    """⚠️ KESİLME KAPISI (2026-09-14, canlı hata): bu uç `limit` ile kesiyor ve
    KESTİĞİNİ SÖYLEMİYOR. `gun=90&limit=1000` istedim, 1000 satır döndü ve ben
    90 günü ölçtüğümü sandım — oysa veri yalnız 26 güne iniyordu. Sonuç:
    "Redbull girişi 90 gündür HİÇ kaydedilmemiş" diye rapor ettim; gerçekte
    10 Temmuz'da +384'lük bir teslim girişi VARDI, penceremin dışındaydı.
    Sahip düzeltti. Artık kesilme tespit edilir ve AÇIKÇA söylenir."""
    d = g("/ops/stok-hareketleri?gun=%d&limit=%d" % (GUN, LIMIT))
    sat = _liste(d)
    global KESILDI
    KESILDI = len(sat) >= LIMIT
    if KESILDI:
        _z = [str(x.get("zaman"))[:10] for x in sat if x.get("zaman")]
        print("")
        print("🔴 VERİ KESİLDİ — %d satır tavana dayandı." % len(sat))
        print("   İstenen pencere %d gün ama eldeki veri yalnız %s tarihine iniyor."
              % (GUN, min(_z) if _z else "?"))
        print("   Genel oranlar BU DAR pencereye aittir; 3. bölüm kalem bazında")
        print("   KESİNTİSİZ ölçüldüğü için ondan etkilenmez.")
        print("")
    return sat


KESILDI = False


def bas(t):
    print("\n" + "=" * 92)
    print(t)
    print("=" * 92)


sat = hareketler()
print("=" * 92)
print("STOK DEFTERİ DÜRÜSTLÜK ÖLÇÜMÜ — %s · son %d gün · %d hareket"
      % (datetime.date.today(), GUN, len(sat)))
print("kesim: %s (bulundu doktrini)" % KESIM)
print("=" * 92)


def tarih(x):
    try:
        return datetime.date.fromisoformat(str(x.get("zaman"))[:10])
    except Exception:  # noqa: BLE001
        return None


def kars(x):
    """Bu satır kendi aritmetiğini bozuyor mu? (fark, yoksa 0)"""
    try:
        o = float(x.get("onceki_miktar"))
        s = float(x.get("sonraki_miktar"))
        m = float(x.get("miktar") or 0)
    except (TypeError, ValueError):
        return 0.0
    f = (s - o) - m
    return abs(f) if abs(f) > 0.01 else 0.0


# ── 1) İKİ DÖNEM ──────────────────────────────────────────────────────
for etiket, suz in (("KESİMDEN SONRA (düzeltmenin karnesi · hedef 0)",
                     lambda t: t is not None and t >= KESIM),
                    ("KESİMDEN ÖNCE (dondurulmuş tarih · azalması beklenmez)",
                     lambda t: t is not None and t < KESIM)):
    bas(etiket)
    tur = collections.Counter()
    kus = collections.Counter()
    ad = collections.Counter()
    for x in sat:
        if not suz(tarih(x)):
            continue
        t = str(x.get("hareket_turu"))
        tur[t] += 1
        f = kars(x)
        if f:
            kus[t] += 1
            ad[t] += f
    if not tur:
        print("  (bu dönemde hareket yok)")
        continue
    print("%-16s %7s %12s %8s %9s" % ("TÜR", "TOPLAM", "KARŞILIKSIZ", "ORAN", "ADET"))
    print("-" * 56)
    for t, n in tur.most_common():
        k = kus.get(t, 0)
        print("%-16s %7d %12d %7.1f%% %9g" % (t[:16], n, k, 100.0 * k / max(1, n), ad.get(t, 0)))
    print("-" * 56)
    print("%-16s %7d %12d %7.1f%% %9g" % ("TOPLAM", sum(tur.values()), sum(kus.values()),
          100.0 * sum(kus.values()) / max(1, sum(tur.values())), sum(ad.values())))

# ── 2) YENİ DOKTRİN SATIRLARI ─────────────────────────────────────────
bas("'BULUNDU' SATIRLARI — doktrin çalışıyor mu? (iş sinyali)")
bul = collections.Counter()
bul_ad = collections.Counter()
for x in sat:
    if str(x.get("hareket_turu")) != "SAYIM_DUZELTME":
        continue
    kt = str(x.get("kaynak_tip") or "")
    if not kt.endswith("_bulunan"):
        continue
    bul[kt] += 1
    try:
        bul_ad[kt] += abs(float(x.get("miktar") or 0))
    except (TypeError, ValueError):
        pass
if not bul:
    print("  henüz yok — doktrin yeni indi ya da defter yetmeyen çıkış olmadı")
for k, n in bul.most_common():
    print("  %-22s %4d satır · %g adet" % (k, n, bul_ad.get(k, 0)))

# ── 3) KÖK NEDEN: girişi hiç kaydedilmemiş kalemler ───────────────────
bas("KÖK NEDEN — girişi HİÇ kaydedilmemiş ama çıkışı olan kalemler")
# ⚠️ Bu bölüm KALEM BAZINDA sorgulanır (uç `kalem_kodu` süzgeci kabul ediyor).
# Sebep: genel sorgu `limit` ile kesiliyor ve bir kalemin ESKİ girişini
# pencere dışında bırakabiliyor — "hiç giriş yok" diye YANLIŞ rapor doğar.
# Canlı hata (2026-09-14): Redbull'un 10 Temmuz'daki +384 teslim girişi
# kesik pencerenin dışında kalmıştı; "hiç kaydedilmemiş" dedim, yanlıştı.
import urllib.parse as _up  # noqa: E402

adaylar = {}
for x in sat:
    if kars(x):
        adaylar[(str(x.get("sube_id")), str(x.get("kalem_kodu")))] = str(x.get("kalem_adi") or "")
print("karşılıksız üreten %d (şube,kalem) çifti — her biri 365 günle, KESİNTİSİZ sorgulanıyor…"
      % len(adaylar))
rows = []
for (sb, kod), kad in adaylar.items():
    try:
        li = _liste(g("/ops/stok-hareketleri?gun=365&sube_id=%s&kalem_kodu=%s&limit=%d"
                      % (_up.quote(sb), _up.quote(kod), LIMIT)))
    except Exception:  # noqa: BLE001
        continue
    gir = cik = 0.0
    songir = "-"
    for y in li:
        try:
            m = float(y.get("miktar") or 0)
        except (TypeError, ValueError):
            continue
        if m > 0:
            gir += m
            z = str(y.get("zaman"))[:10]
            if z > songir:
                songir = z
        else:
            cik += abs(m)
    rows.append((sb, kad or kod, gir, cik, cik - gir, songir))
rows.sort(key=lambda r: -r[4])
print()
print("%-11s %-22s %9s %9s %9s %s" % ("ŞUBE", "KALEM", "GİRİŞ", "ÇIKIŞ", "AÇIK", "SON GİRİŞ"))
print("-" * 78)
for sb, kad, gir, cik, ack, songir in rows[:15]:
    print("%-11s %-22s %9g %9g %9g %s" % (sb[:11], kad[:22], gir, cik, ack, songir))
print("-" * 78)
hic = [r for r in rows if r[2] == 0]
print("%-34s %9g %9g %9g" % ("TOPLAM (%d kalem)" % len(rows),
      sum(r[2] for r in rows), sum(r[3] for r in rows), sum(r[4] for r in rows)))
print()
print("  girişi GERÇEKTEN hiç olmayan : %d kalem" % len(hic))
print("  girişi var ama YETMEYEN      : %d kalem" % len([r for r in rows if r[2] > 0 and r[4] > 0]))
print()
print("▸ AÇIK = çıkış − giriş. Pozitifse deftere girenden ÇOK çıkmış.")
print("  ⚠️ 'Giriş hiç yok' ile 'giriş var ama DURMUŞ' AYRI sorunlardır:")
print("     birincisi kayıt hiç açılmamış, ikincisi kayıt bir süre sonra bırakılmış.")
print("     SON GİRİŞ sütunu bunu söyler — eski tarihse akış kesilmiş demektir.")

# ── 4) AÇIK SİNYAL SAYISI ─────────────────────────────────────────────
bas("AÇIK SİNYAL — ekranda iş olarak bekleyen")
try:
    d = g("/ops/urun-uyumsuzluk?gun=%d" % min(180, GUN))
    li = d.get("liste") or []
    c = collections.Counter()
    for x in li:
        if not x.get("cozuldu"):
            c[str(x.get("tip"))] += 1
    for k, n in c.most_common():
        print("  %-24s %d açık" % (k, n))
    if not c:
        print("  açık sinyal yok ✓")
except Exception as e:  # noqa: BLE001
    print("  okunamadı: %s" % str(e)[:90])

print()
print("=" * 92)
print("⚠️ 'Karşılıksız 0' TEK BAŞINA başarı değildir — doktrin farkı")
print("   SAYIM_DUZELTME'ye çevirdiği için tanım gereği 0'a iner.")
print("   Gerçek ölçüt: 3. bölümdeki KALEM SAYISI azalmalı.")
print("=" * 92)
