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


def hareketler():
    d = g("/ops/stok-hareketleri?gun=%d&limit=1000" % GUN)
    sat = d.get("hareketler") or d.get("satirlar") or []
    if not sat and isinstance(d, dict):
        for v in d.values():
            if isinstance(v, list) and v:
                return v
    return sat


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
ix = collections.defaultdict(lambda: {"gir": 0.0, "cik": 0.0, "k": 0.0})
for x in sat:
    key = (str(x.get("sube_id")), str(x.get("kalem_adi") or x.get("kalem_kodu")))
    try:
        m = float(x.get("miktar") or 0)
    except (TypeError, ValueError):
        continue
    r = ix[key]
    if m > 0:
        r["gir"] += m
    else:
        r["cik"] += abs(m)
    r["k"] += kars(x)
kotu = sorted([(k, v) for k, v in ix.items() if v["gir"] == 0 and v["cik"] > 0 and v["k"] > 0],
              key=lambda z: -z[1]["k"])
print("%-11s %-24s %8s %11s" % ("ŞUBE", "KALEM", "ÇIKIŞ", "KARŞILIKSIZ"))
print("-" * 60)
for (sb, kad), v in kotu[:15]:
    print("%-11s %-24s %8g %11g" % (sb[:11], kad[:24], v["cik"], v["k"]))
print("-" * 60)
print("%-36s %8g %11g" % ("TOPLAM (%d kalem)" % len(kotu),
      sum(v["cik"] for _, v in kotu), sum(v["k"] for _, v in kotu)))
sb_c = collections.Counter(sb for (sb, _), _ in kotu)
print("şube dağılımı: %s" % dict(sb_c))
print()
print("▸ Bu liste ASIL İŞTİR: mal fiziken geliyor, deftere HİÇ yazılmıyor.")
print("  'Yanlış rakam girilmiş' değil — 'hiç girilmemiş'. Kalem sayısı")
print("  azalmıyorsa düzeltme çalışıyor ama KAYIT DİSİPLİNİ değişmemiş demektir.")

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
