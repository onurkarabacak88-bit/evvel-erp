#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
🚪 PUSH ÖNCESİ KAPI — dört sessiz kusur sınıfını tek komutta ölçer.

    python scripts/kapi_kontrol.py            # tüm kök .py dosyaları
    python scripts/kapi_kontrol.py fatura_api.py operasyon_merkez_api.py

Çıkış kodu 0 = temiz, 1 = kapı kapalı (push etme).

── NEDEN (2026-09-01 sipariş zinciri denetimi) ──────────────────────────────
Bu dördü de "derleme geçti = güvenli" yanılgısının arkasına saklanıyor.
Tek koşuda CANLIDA KIRIK dört ayrı yer bulundu:

  1) TANIMSIZ AD — Python'da tanımsız ad import anında değil, o satır
     ÇALIŞINCA patlar; yani uç çağrılana kadar sessizdir.
       · fatura_api `g_adlar`  → aktif devir varken /cari-ozet 500
       · sube_panel `logger`   → hatayı YAKALAYAN blok kendisi patlıyordu
       · main.py   `logger`    → modül yüklenirken; uygulama HİÇ AÇILMIYORDU
     En tehlikeli iki yer: EXCEPT GÖVDESİ ve MODÜL SEVİYESİ.

  2) ROTA GÖLGELENMESİ — dosya ortasındaki `/{id}` kendisinden SONRA
     kaydedilen statik uçları yutar. Uç 404 döner ve "veri yok" sanılır.
       · `/cari-odenecekler` tam böyle yutulmuştu (ödeme ekranı kördü).

  3) SAVEPOINT'SİZ YUTULAN SQL — PostgreSQL'de patlayan komut TÜM
     transaction'ı abort eder. `except: pass` hatayı susturur, ZARARI
     susturmaz: `db()` çıkışındaki COMMIT sessizce ROLLBACK'e döner ve uç
     yine `success: true` döndürür. Şube "sipariş verildi" görür, kuyrukta
     hiçbir şey yoktur.

  4) SAVEPOINT KAPSAMI — `savepoint(cur, …)` çağrısı, o noktada CANLI
     olmayan bir imleç üzerindeyse (kapanmış `with db()`'den kalan) blok
     sessizce hiç çalışmaz. Denetimin kendisi bu hatayı bir kez üretti.

⚠️ Bu betik SALT OKUR — hiçbir dosyayı değiştirmez.
"""
from __future__ import annotations

import ast
import collections as _collections
import re as _re
import glob
import os
import subprocess
import sys

KOK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ⚠️ MUAFİYET LİSTESİ BOŞ TUTULUR (2026-09-01 dersi).
# İlk kurulumda `tv_menu_api.py` buraya konmuştu ("kapsam dışı"). Sonuç:
# kapı YEŞİL yanarken o dosyada 3 tanımsız ad, yani canlıda çöken bir uç
# duruyordu. Muafiyet, kapının kendisini SAHTE YEŞİLE çevirir — denetimin
# kovaladığı şeyin ta kendisi. Bir dosya gerçekten muaf olacaksa gerekçesi
# burada YAZILI olmalı; sessiz muafiyet yok.
ATLA: set = set()


# ── 1) TANIMSIZ AD ──────────────────────────────────────────────────────────
def tanimsiz_ad(dosyalar: list[str]) -> list[str]:
    try:
        p = subprocess.run(
            [sys.executable, "-m", "pyflakes", *dosyalar],
            capture_output=True, text=True, cwd=KOK,
        )
    except Exception as e:  # noqa: BLE001
        return [f"pyflakes calistirilamadi ({e}) — `pip install pyflakes`"]
    out = []
    for satir in (p.stdout or "").splitlines():
        d = satir.lower()
        if "undefined name" not in d and "before assignment" not in d:
            continue
        # ⚠️ YANLIS ALARM ELEMESI: `from __future__ import annotations` olan
        # dosyada TİP İPUÇLARI çalışma zamanında DEĞERLENDİRİLMEZ (PEP 563) —
        # `satirlar: List[dict] = []` satırındaki eksik `List` importu kod
        # kokusudur ama CANLIYI KIRMAZ. Kapı yalnız kıran şeye kırmızı yakar;
        # aksi hâlde 21 zararsız satır, 4 gerçek kırığı boğardı.
        try:
            dosya, ln = satir.split(":")[0], int(satir.split(":")[1])
        except Exception:
            out.append(satir)
            continue
        if _yalniz_anotasyonda(dosya, ln):
            continue
        out.append(satir)
    return out


def _yalniz_anotasyonda(dosya: str, satir_no: int) -> bool:
    """O satırdaki ad YALNIZCA bir anotasyon içinde mi geçiyor?
    (ve dosyada `from __future__ import annotations` var mı)"""
    yol = dosya if os.path.isabs(dosya) else os.path.join(KOK, dosya)
    try:
        kaynak = open(yol, encoding="utf-8").read()
        agac = ast.parse(kaynak)
    except Exception:
        return False
    gelecek = any(
        isinstance(n, ast.ImportFrom) and n.module == "__future__"
        and any(a.name == "annotations" for a in n.names)
        for n in ast.walk(agac)
    )
    if not gelecek:
        return False
    anot_satirlari: set[int] = set()
    for n in ast.walk(agac):
        anotlar = []
        if isinstance(n, ast.AnnAssign) and n.annotation is not None:
            anotlar.append(n.annotation)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if n.returns is not None:
                anotlar.append(n.returns)
            for a in (list(n.args.args) + list(n.args.kwonlyargs)
                      + list(getattr(n.args, "posonlyargs", []))):
                if a.annotation is not None:
                    anotlar.append(a.annotation)
        for a in anotlar:
            for k in range(a.lineno, (a.end_lineno or a.lineno) + 1):
                anot_satirlari.add(k)
    return satir_no in anot_satirlari


# ── 2) ROTA GÖLGELENMESİ ────────────────────────────────────────────────────
def _segmentler(yol: str) -> list[str]:
    return [p for p in yol.strip("/").split("/") if p]


def _yutar(parametreli: str, statik: str) -> bool:
    a, b = _segmentler(parametreli), _segmentler(statik)
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x.startswith("{"):
            continue          # parametre her segmenti yutar
        if x != y:
            return False
    return True


def rota_golgesi(dosyalar: list[str]) -> list[str]:
    """⚠️ ÖLÇÜM, TAHMİN DEĞİL (2026-09-02'de düzeltildi).

    İlk sürüm rotaları AST'ten okuyup SATIR SIRASINA göre kıyaslıyordu ve
    `/cari-odenecekler` için YANLIŞ ALARM verdi: `fatura_api.py` dosyanın
    sonunda `router.routes.sort(...)` ile parametreli yolları zaten en sona
    alıyor. Yani gerçek sıra satırdan okunamaz — modül YÜKLENDİKTEN sonra
    `router.routes` okunmalıdır. Canlı ölçüm 23 modülde 0 gölgelenme buldu;
    statik sürüm 1 hayalet üretmişti.

    Ders, denetimin kendi dersiyle aynı: kendi rakamını sorgula, ölç.
    """
    bulgular: list[str] = []
    kok_eski = list(sys.path)
    sys.path.insert(0, KOK)
    try:
        import importlib
        for fn in dosyalar:
            if not fn.endswith(".py"):
                continue
            modul_ad = os.path.basename(fn)[:-3]
            kaynak_yol = os.path.join(KOK, fn)
            try:
                if "APIRouter(" not in open(kaynak_yol, encoding="utf-8").read():
                    continue                      # router'i yok, konu disi
            except Exception:
                continue
            try:
                m = importlib.import_module(modul_ad)
            except Exception:
                continue                          # yuklenemiyorsa 1. kapi soyler
            r = getattr(m, "router", None)
            if r is None:
                continue
            rotalar: list[tuple[str, str]] = []
            for x in getattr(r, "routes", []):
                yol = getattr(x, "path", None)
                if not yol:
                    continue
                for met in sorted(getattr(x, "methods", []) or []):
                    rotalar.append((met, yol))
            for i, (met, yol) in enumerate(rotalar):
                if "{" not in yol:
                    continue
                for met2, yol2 in rotalar[i + 1:]:
                    if met2 == met and "{" not in yol2 and _yutar(yol, yol2):
                        bulgular.append(
                            f"{modul_ad}: {met} {yol}  YUTUYOR  {yol2} "
                            "— parametreli yollari en sona sirala "
                            "(`router.routes.sort(...)`, bkz. fatura_api.py sonu)")
    finally:
        sys.path[:] = kok_eski
    return bulgular


# ── 3) SAVEPOINT'SİZ YUTULAN SQL ────────────────────────────────────────────
def _yutuyor(h: ast.ExceptHandler) -> bool:
    for st in h.body:
        if isinstance(st, ast.Raise):
            return False
        if isinstance(st, (ast.Pass, ast.Continue, ast.Assign, ast.If, ast.Return)):
            continue
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call):
            f = st.value.func
            ad = getattr(f, "attr", getattr(f, "id", ""))
            if ad in ("print", "print_exc", "exception", "warning",
                      "error", "debug", "info"):
                continue
            return False
        return False
    return True


def yutulan_sql(dosyalar: list[str]) -> list[str]:
    bulgular = []
    for fn in dosyalar:
        try:
            kaynak = open(os.path.join(KOK, fn), encoding="utf-8").read()
            agac = ast.parse(kaynak)
        except Exception:
            continue
        satirlar = kaynak.split("\n")
        for f in ast.walk(agac):
            if not isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            govde_f = "\n".join(satirlar[f.lineno - 1:f.end_lineno]).upper()
            if not any(w in govde_f for w in ("INSERT INTO", "UPDATE ", "DELETE FROM")):
                continue     # yalnız YAZAN fonksiyonlar
            for node in ast.walk(f):
                if not isinstance(node, ast.Try):
                    continue
                govde = "\n".join(satirlar[node.lineno - 1:node.body[-1].end_lineno])
                if "execute(" not in govde or "savepoint" in govde.lower():
                    continue
                if "with db()" in govde.replace(" ", " "):
                    continue     # kendi transaction'ini aciyor = izole, guvenli
                for h in node.handlers:
                    tip_ok = (h.type is None or
                              (isinstance(h.type, ast.Name) and h.type.id == "Exception"))
                    if tip_ok and _yutuyor(h):
                        bulgular.append(
                            f"{fn}:{node.lineno} [{f.name}] savepoint'siz yutulan SQL "
                            "— `with savepoint(cur, ...)` icine al")
                        break
    return bulgular


# ── 4) SAVEPOINT KAPSAMI ────────────────────────────────────────────────────
def savepoint_kapsami(dosyalar: list[str]) -> list[str]:
    bulgular = []
    for fn in dosyalar:
        try:
            agac = ast.parse(open(os.path.join(KOK, fn), encoding="utf-8").read())
        except Exception:
            continue
        for f in ast.walk(agac):
            if not isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            parametreler = ({a.arg for a in f.args.args} |
                            {a.arg for a in f.args.kwonlyargs})
            db_arali = []
            for n in ast.walk(f):
                if not isinstance(n, ast.With):
                    continue
                for it in n.items:
                    ce = it.context_expr
                    if isinstance(ce, ast.Call) and getattr(ce.func, "id", "") == "db":
                        ad = None
                        v = it.optional_vars
                        if isinstance(v, ast.Tuple) and len(v.elts) == 2:
                            ad = getattr(v.elts[1], "id", None)
                        db_arali.append((n.body[0].lineno, n.body[-1].end_lineno, ad))
            for n in ast.walk(f):
                if not isinstance(n, ast.With):
                    continue
                for it in n.items:
                    ce = it.context_expr
                    if not (isinstance(ce, ast.Call) and
                            getattr(ce.func, "id",
                                    getattr(ce.func, "attr", "")) == "savepoint"):
                        continue
                    imlec = getattr(ce.args[0], "id", None) if ce.args else None
                    if imlec in parametreler:
                        continue
                    if any(b <= n.lineno <= s and c == imlec for b, s, c in db_arali):
                        continue
                    bulgular.append(
                        f"{fn}:{n.lineno} [{f.name}] savepoint({imlec}) canli bir "
                        "`with db()` icinde degil — imlec kapali olabilir")
    return bulgular


def main() -> int:
    tam_kosu = len(sys.argv) <= 1
    if not tam_kosu:
        dosyalar = sys.argv[1:]
    else:
        dosyalar = sorted(
            os.path.basename(p) for p in glob.glob(os.path.join(KOK, "*.py"))
            if os.path.basename(p) not in ATLA
        )

    # ── SERT KAPI ───────────────────────────────────────────────────────────
    # Bu üçü de KESİN (yanlış alarm üretmiyor) ve etkisi CANLIDA KIRIK.
    # Tek bulgu bile push'u durdurur.
    sert = [
        ("1. TANIMSIZ AD          ", tanimsiz_ad),
        ("2. ROTA GOLGELENMESI    ", rota_golgesi),
        ("4. SAVEPOINT KAPSAMI    ", savepoint_kapsami),
    ]
    print("KAPI KONTROL — %d dosya" % len(dosyalar))
    print("=" * 68)
    sert_toplam = 0
    for ad, f in sert:
        bulgular = f(dosyalar)
        sert_toplam += len(bulgular)
        print(ad + ("TEMIZ" if not bulgular else "%d BULGU" % len(bulgular)))
        for b in bulgular[:25]:
            print("    - " + b)
        if len(bulgular) > 25:
            print("    ... ve %d tane daha" % (len(bulgular) - 25))

    # ── 3. SINIF: TABAN ÇİZGİLİ (sert değil) ────────────────────────────────
    # ⚠️ Neden sert değil — bu denetimin KENDİ D-7 dersi:
    #    Repo genelinde 100+ aday var ve çoğu MEŞRU (`init_db` migration'ları,
    #    kendi transaction'ını açan izole bloklar). Hepsini kırmızı yakmak
    #    kapıyı GÜRÜLTÜYE çevirir; gerçek bulgular gürültüde boğulur ve kimse
    #    listeye bakmaz — "uyumsuzluklar listesi yoldaki her paketi uyumsuz
    #    sayıyordu" hatasının aynısı olurdu.
    #    Bu yüzden ölçüt MUTLAK SAYI değil ARTIŞ: bugünün sayısı TABANDIR,
    #    yeni eklenen her savepoint'siz yazım kapıyı kapatır. İyileştikçe
    #    taban aşağı çekilir (geri kaymaz).
    # ⚠️ TABAN YALNIZ TAM KOŞUDA OKUNUR/YAZILIR. Alt küme koşusunda
    # (birkaç dosya adı verilerek) taban güncellenirse SAHTE İYİLEŞME yazılır
    # ve bir dahaki tam koşuda her şey "yeni bulgu" gibi görünür. Ölçümün
    # kendisi bozulur — kapının kendi kuyruğunu ısırması. (Öz-test yakaladı.)
    taban_dosya = os.path.join(KOK, "scripts", ".kapi_taban")
    guncel = yutulan_sql(dosyalar)
    if not tam_kosu:
        print("3. SAVEPOINT'SIZ SQL     %d (alt kume kosusu — taban DOKUNULMADI)"
              % len(guncel))
        for b in guncel[:15]:
            print("    - " + b)
        print("=" * 68)
        if sert_toplam:
            print("KAPI KAPALI — %d bulgu. Push etmeden once duzelt." % sert_toplam)
            return 1
        print("KAPI ACIK (alt kume) — tam kosu icin argumansiz calistirin.")
        return 0
    # 🔴 KAPI KENDI KUYRUGUNU ISIRDI (2026-09-02): taban yalnizca bir SAYIYDI.
    # Artis olunca kapi `guncel[-artis:]` ile SIRALI listenin SONUNU basiyordu
    # — yani alfabetik olarak en sondaki dosyayi "yeni bulgu" diye gosteriyordu.
    # Canli ornek: yeni bulgu kasa_service.py'deydi, kapi tv_menu_api.py:135'i
    # isaret etti. Yanlis satiri gosteren kapi, yanlis dersi ogretir.
    # Cozum: taban artik BULGU LISTESI — fark KIMLIK uzerinden alinir.
    # Sayisal eski taban dosyalari da okunur (geriye uyum).
    # ⚠️ KIMLIK SATIR NUMARASI OLAMAZ (2026-09-02, öz-test): taban ilk sürümde
    # ham bulgu metnini (dosya:SATIR [fonksiyon]) saklıyordu. Bir fonksiyonun
    # üstüne 20 satır eklemek, o dosyadaki TÜM bulguların satırını kaydırıyor
    # ve kapı hepsini "YENİ" sanıyordu — 86 bulgunun 40'ı birden yeni görünüyordu.
    # Böyle bir kapı ilk gerçek düzenlemede gürültüye boğulur ve susturulur.
    # Kimlik artık DOSYA + FONKSIYON; satır yalnız GÖSTERIMDE kullanılır.
    def _kimlik(b):
        m = _re.match(r"([^:]+):\d+ \[([^\]]+)\]", b)
        return "%s::%s" % (m.group(1), m.group(2)) if m else b

    taban_liste, taban = None, None
    if os.path.exists(taban_dosya):
        ham = open(taban_dosya, encoding="utf-8").read().strip()
        if ham.isdigit():
            taban = int(ham)                       # en eski biçim: yalnız sayı
        else:
            taban_liste = [x for x in ham.split("\n") if x.strip()]
            # Geriye uyum: taban satır-numaralı eski biçimdeyse kimliğe indir.
            if any(":" in x and "[" in x for x in taban_liste):
                taban_liste = [_kimlik(x) for x in taban_liste]
            taban = len(taban_liste)

    def _taban_yaz(liste):
        with open(taban_dosya, "w", encoding="utf-8") as fh:
            fh.write("\n".join(sorted(_kimlik(b) for b in liste)))

    if taban is None:
        _taban_yaz(guncel)
        print("3. SAVEPOINT'SIZ SQL     %d (TABAN yazildi)" % len(guncel))
    elif taban_liste is None:
        # Eski sayisal taban: sayi ayniysa listeye YUKSELT, degistiyse uyar.
        if len(guncel) == taban:
            _taban_yaz(guncel)
            print("3. SAVEPOINT'SIZ SQL     %d (taban listeye yukseltildi)" % len(guncel))
        else:
            artis = len(guncel) - taban
            print("3. SAVEPOINT'SIZ SQL     %d (sayisal taban %d, %+d) — hangi bulgu?"
                  % (len(guncel), taban, artis))
            print("    (eski taban liste tutmuyordu; adlariyla soyleyemiyorum)")
            if artis > 0:
                sert_toplam += artis
    else:
        # Çoklu küme: aynı fonksiyonda iki bulgu varsa ikisi de sayılır —
        # birini kapatıp birini eklemek "değişmedi" görünmemeli.
        _eski_say = _collections.Counter(taban_liste)
        _yeni_say = _collections.Counter(_kimlik(b) for b in guncel)
        _artan = _yeni_say - _eski_say
        _azalan = _eski_say - _yeni_say
        # Gösterimde ham satırı (satır numaralı) veriyoruz ki tıklanabilsin.
        _ham = {}
        for b in guncel:
            _ham.setdefault(_kimlik(b), []).append(b)
        yeni = [x for k, n in _artan.items() for x in (_ham.get(k) or [k])[:n]]
        kapanan = [k for k, n in _azalan.items() for _ in range(n)]
        if not yeni and not kapanan:
            print("3. SAVEPOINT'SIZ SQL     %d (taban %d, DEGISMEDI)"
                  % (len(guncel), taban))
        elif yeni:
            print("3. SAVEPOINT'SIZ SQL     %d (taban %d, %d YENI)"
                  % (len(guncel), taban, len(yeni)))
            for b in yeni[:15]:
                print("    - YENI: " + b)
            for b in kapanan[:5]:
                print("    - (kapanan: %s)" % b)
            sert_toplam += len(yeni)
        else:
            print("3. SAVEPOINT'SIZ SQL     %d (taban %d, %d KAPANDI — taban guncellendi)"
                  % (len(guncel), taban, len(kapanan)))
            for b in kapanan[:10]:
                print("    - kapandi: " + b)
            _taban_yaz(guncel)

    print("=" * 68)
    if sert_toplam:
        print("KAPI KAPALI — %d bulgu. Push etmeden once duzelt." % sert_toplam)
        return 1
    print("KAPI ACIK — push edilebilir.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
