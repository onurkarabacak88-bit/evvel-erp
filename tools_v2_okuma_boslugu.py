# -*- coding: utf-8 -*-
"""OKUMA boşluğu denetimi — yazma denetiminin GÖREMEDİĞİ eksikler.

Neden var: tools_v2_islev_denetimi.py yalnız POST/PUT/PATCH/DELETE sayar.
Klasikte gösterilip v2'ye taşınmayan HESAP/GÖSTERİM kayıpları o sayaca hiç
yansımaz. Sahip bunu gözle yakaladı (Vardiya Takip → ucret_detay, 67c5919);
aynı desenin iki vakası daha vardı (personel_satislar, tahsis[]).

Ölçüm fikri: "uç zaten çağrılıyor ama cevabın alanı kullanılmıyor".
  1) Backend route gövdesinden CEVAP ANAHTARLARI çıkarılır ("anahtar": ...)
  2) O ucu çağıran KLASİK dosyalarda hangi anahtarlar geçiyor → "eskiden vardı"
  3) O ucu çağıran V2 dosyalarında geçmeyenler → ADAY BOŞLUK

⚠️ Çıktı ADAY listesidir, kanıt değil. Anahtar dolaylı kullanılıyor olabilir
(yeniden adlandırma, nested erişim, ara değişken). Kural aynı: DOĞRULA-ÖNCE-EKLE
— dosyayı açıp bak, sonra ekle.
"""
import io, os, re, sys, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

KAPSAM_DISI = {
    'GorevPersonelSayfasi.jsx', 'GorevGiris.jsx', 'StokSayim.jsx',
    'EvTasarim.jsx', 'CepApp.jsx', 'IsBasvuruForm.jsx', 'FireFotoYukle.jsx',
}
# Gürültü: her cevapta geçen teknik alanlar — boşluk sayılmaz
GURULTU = {
    'success', 'detail', 'message', 'mesaj', 'durum', 'id', 'toplam', 'not',
    'hata', 'error', 'ok', 'sonuc', 'kayitlar', 'satirlar', 'items', 'data',
    'olusturma', 'guncelleme', 'tarih', 'ad', 'adet', 'limit', 'sayfa',
}

def yol_normalize(p):
    p = re.sub(r'\$\{[^}]*\}', '{}', p)
    p = p.split('?')[0].rstrip('/')
    p = re.sub(r'^/api', '', p)
    p = re.sub(r'/[0-9a-f]{8}-[0-9a-f-]{20,}', '/{}', p)
    p = re.sub(r'/\d+(?=/|$)', '/{}', p)
    return p

# ── 1) BACKEND: route → cevap anahtarları ────────────────────────────────────
ROUTE = re.compile(r'^@(?:app|router)\.(get|post|put|patch|delete)\(\s*["\']([^"\']+)["\']', re.M)
PREFIX = re.compile(r'APIRouter\(\s*prefix\s*=\s*["\']([^"\']+)["\']')
ANAHTAR = re.compile(r'["\']([A-Za-zğüşöçıİĞÜŞÖÇ_][A-Za-zğüşöçıİĞÜŞÖÇ_0-9]{2,})["\']\s*:')

def backend_haritasi():
    harita = {}
    for f in glob.glob('*.py'):
        if f.startswith('test_') or f.startswith('tools_'):
            continue
        try:
            s = io.open(f, encoding='utf-8').read()
        except Exception:
            continue
        pm = PREFIX.search(s)
        prefix = pm.group(1) if pm else ''
        satirlar = s.split('\n')
        yerler = [(m.start(), m.group(1), m.group(2)) for m in ROUTE.finditer(s)]
        for i, (poz, _metot, yol) in enumerate(yerler):
            son = yerler[i + 1][0] if i + 1 < len(yerler) else len(s)
            govde = s[poz:son]
            tam = yol if yol.startswith('/api') else (prefix + yol if prefix else yol)
            k = yol_normalize(tam)
            harita.setdefault(k, set()).update(
                a for a in ANAHTAR.findall(govde) if a.lower() not in GURULTU
            )
    return harita

# ── 2) FRONTEND: dosya → çağırdığı uçlar ─────────────────────────────────────
CAGRI = re.compile(r"""(?:api|fetch)\(\s*[`'"]([^`'"]+)[`'"]""")

def cagri_haritasi(dosyalar):
    d2u, u2d = {}, {}
    for f in dosyalar:
        try:
            s = io.open(f, encoding='utf-8').read()
        except Exception:
            continue
        ucler = set()
        for yol in CAGRI.findall(s):
            if not yol.startswith('/'):
                continue
            ucler.add(yol_normalize(yol))
        d2u[f] = (ucler, s)
        for u in ucler:
            u2d.setdefault(u, set()).add(f)
    return d2u, u2d

klasik_dosya = [f for f in glob.glob('src/pages/*.jsx')
                if os.path.basename(f) not in KAPSAM_DISI]
v2_dosya = glob.glob('src/pages/v2/*.jsx')

be = backend_haritasi()
kd2u, ku2d = cagri_haritasi(klasik_dosya)
vd2u, vu2d = cagri_haritasi(v2_dosya)

def kullanilan(dosyalar, d2u, anahtarlar):
    """Bu dosyaların METNİNDE geçen anahtarlar."""
    bulunan = set()
    for f in dosyalar:
        s = d2u.get(f, (None, ''))[1]
        for a in anahtarlar:
            if re.search(r'\b' + re.escape(a) + r'\b', s):
                bulunan.add(a)
    return bulunan

# ⭐ SAHİP UYARISI (2026-07-31): "başka alanların içine taşınma var mı kontrol et".
# Bir bölüm BAŞKA bir v2 modülünde yeniden kurulmuş olabilir (ör. sube_karne →
# Panel ▸ Şube Karnesi). Ucu çağıran dosyaya bakmak YETMEZ; v2'nin TAMAMINA bak.
V2_TUM_METIN = ''
for _f in v2_dosya + glob.glob('src/pages/v2/*.js'):
    try:
        V2_TUM_METIN += io.open(_f, encoding='utf-8').read()
    except Exception:
        pass

def v2de_baska_yerde(a):
    return bool(re.search(r'\b' + re.escape(a) + r'\b', V2_TUM_METIN))

# ── 3) KARŞILAŞTIR ───────────────────────────────────────────────────────────
ortak, hic_yok = [], []
for uc, kdos in sorted(ku2d.items()):
    anahtarlar = be.get(uc)
    if not anahtarlar:
        continue
    vdos = vu2d.get(uc)
    if not vdos:
        klasikte = kullanilan(kdos, kd2u, anahtarlar)
        if len(klasikte) >= 3:
            hic_yok.append((uc, sorted(kdos and {os.path.basename(x) for x in kdos}), len(klasikte)))
        continue
    k_kul = kullanilan(kdos, kd2u, anahtarlar)
    v_kul = kullanilan(vdos, vd2u, anahtarlar)
    ham = sorted(k_kul - v_kul)
    # İKİ KOVA: gerçekten hiç yok  ·  v2'de BAŞKA dosyada geçiyor (taşınmış olabilir)
    gercek = [a for a in ham if not v2de_baska_yerde(a)]
    tasinmis = [a for a in ham if v2de_baska_yerde(a)]
    if gercek:
        ortak.append((len(gercek), uc, gercek, tasinmis,
                      sorted({os.path.basename(x) for x in kdos}),
                      sorted({os.path.basename(x) for x in vdos})))

ortak.sort(reverse=True)

print("=" * 70)
print("OKUMA BOŞLUĞU DENETİMİ — 'uç çağrılıyor ama alan kullanılmıyor'")
print("=" * 70)
print(f"Backend'de anahtarı çıkarılan uç : {len(be)}")
print(f"Ortak uçta ADAY boşluk           : {len(ortak)}")
print(f"v2'nin HİÇ çağırmadığı zengin uç : {len(hic_yok)}")
print()
print("--- A) ORTAK UÇ, KLASİKTE KULLANILAN AMA v2'DE HİÇ GEÇMEYEN ALANLAR ---")
print("    (v2'nin TAMAMI tarandı — başka modüle taşınmışlar ayrı satırda)")
for adet, uc, eksik, tasinmis, kf, vf in ortak[:25]:
    print(f"\n### {uc}   ({adet} gerçek eksik)")
    print(f"    klasik: {', '.join(kf[:3])}   →   v2: {', '.join(vf[:3])}")
    print(f"    ❌ hiç yok  : {', '.join(eksik[:14])}" + (' …' if len(eksik) > 14 else ''))
    if tasinmis:
        print(f"    ↔ başka v2 dosyasında geçiyor (taşınmış olabilir): {', '.join(tasinmis[:10])}"
              + (' …' if len(tasinmis) > 10 else ''))

print("\n\n--- B) v2'NİN HİÇ ÇAĞIRMADIĞI UÇLAR (klasik zengin kullanıyordu) ---")
for uc, kf, n in sorted(hic_yok, key=lambda x: -x[2])[:20]:
    print(f"  {n:>3} alan  {uc:<46} ({', '.join(kf[:2])})")
print("\n⚠️ ADAY listesidir — dosyayı AÇIP doğrulamadan ekleme yapma.")
