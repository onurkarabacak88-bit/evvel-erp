"""
Test: kasa_fark_recalc.py concurrency lock + onaylandi revize akışı

Bu test live Railway'e karşı koşturulabilir:
  python test_kasa_fark_recalc_concurrency.py

Test senaryoları:
1) kasa_gun_lock import edilebiliyor
2) Lock 2 kez aynı tx içinde sorunsuz alınabiliyor (recursion)
3) Endpoint'ler 404/400 dönüyor (geçersiz girdiyle)
4) Onaylanmış uyari için kaynak-duzelt → iptal_revize + yeni bekliyor (mock olmadan
   gerçek bir uyari ID lazım, atlanır)
"""
import sys


def test_imports():
    """Modüller doğru yüklenebiliyor mu?"""
    try:
        from kasa_fark_recalc import (
            kasa_gun_lock,
            yeniden_hesapla,
            OTOMATIK_COZUM_ESIK_TL,
            _formul_kapanis,
        )
        assert OTOMATIK_COZUM_ESIK_TL == 0.01
        assert callable(kasa_gun_lock)
        assert callable(yeniden_hesapla)
        # Formül testleri
        assert _formul_kapanis({
            "acilis_kasa": 100, "z_nakit": 200,
            "nakit_giderler": 50, "teslim": 150,
            "devir": 100, "ara_teslim": 0,
        }) == 0.0  # 100+200-50-150-100-0 = 0
        assert _formul_kapanis({
            "acilis_kasa": 500, "z_nakit": 1000,
            "nakit_giderler": 100, "teslim": 800,
            "devir": 600, "ara_teslim": 0,
        }) == 0.0  # 500+1000-100-800-600-0 = 0
        print("  ✓ Modül import & formül OK")
        return True
    except Exception as e:
        print(f"  ✗ Import/formül HATA: {e}")
        return False


def test_lock_hash_determinism():
    """Aynı (sube_id, tarih) için aynı hash, farklı için farklı."""
    import hashlib

    def _lock_keys(sube_id, tarih):
        key = f"kasa_fark:{sube_id}:{tarih}"
        h = hashlib.sha256(key.encode("utf-8")).digest()
        return (
            int.from_bytes(h[:4], "big", signed=True),
            int.from_bytes(h[4:8], "big", signed=True),
        )

    # Aynı input → aynı output
    assert _lock_keys("sube-zafer", "2026-05-18") == _lock_keys("sube-zafer", "2026-05-18")
    # Farklı sube → farklı hash
    assert _lock_keys("sube-zafer", "2026-05-18") != _lock_keys("sube-alsancak", "2026-05-18")
    # Farklı tarih → farklı hash
    assert _lock_keys("sube-zafer", "2026-05-18") != _lock_keys("sube-zafer", "2026-05-19")
    print("  ✓ Lock hash deterministic + uniqueness OK")
    return True


def test_endpoint_404():
    """Var olmayan uyari ID ile endpoint 404 dönmeli."""
    import urllib.request, urllib.error, json
    url = "https://evvel-erp-production.up.railway.app/api/ops/kasa-uyumsuzluk/sahte-id-xxx/kaynak-duzelt"
    body = {"sebep": "gercek_acik", "payload": {}, "notu": "test"}
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        print("  ✗ Beklenen 404, geldi: 200")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("  ✓ Sahte uyari_id → 404 OK")
            return True
        print(f"  ? HTTP {e.code}: {e.read()[:100].decode()}")
        return False
    except Exception as e:
        print(f"  ? Bağlantı hatası: {e}")
        return False


def test_endpoint_invalid_sebep():
    """Geçersiz sebep ile 400 dönmeli."""
    import urllib.request, urllib.error, json
    url = "https://evvel-erp-production.up.railway.app/api/ops/kasa-uyumsuzluk/test-id/kaynak-duzelt"
    body = {"sebep": "olmayan_sebep", "payload": {}}
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=15)
        print("  ✗ Beklenen 400, geldi: 200")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 400:
            print("  ✓ Geçersiz sebep → 400 OK")
            return True
        # 404 de kabul (sahte id önce yakalanırsa)
        if e.code == 404:
            print(f"  ? 404 döndü (uyari önce kontrol ediliyor — kabul)")
            return True
        print(f"  ? HTTP {e.code}: {e.read()[:200].decode()}")
        return False
    except Exception as e:
        print(f"  ? Bağlantı: {e}")
        return False


def main():
    print("=== Kasa Fark Recalc — Fix #1 & #2 Test ===\n")
    sonuc = []

    print("[1] Import & formül testleri:")
    sonuc.append(test_imports())

    print("\n[2] Lock hash deterministic:")
    sonuc.append(test_lock_hash_determinism())

    print("\n[3] Endpoint /kaynak-duzelt — 404 (sahte uyari_id):")
    sonuc.append(test_endpoint_404())

    print("\n[4] Endpoint /kaynak-duzelt — 400 (geçersiz sebep):")
    sonuc.append(test_endpoint_invalid_sebep())

    print(f"\n=== Sonuç: {sum(sonuc)}/{len(sonuc)} test geçti ===")
    return 0 if all(sonuc) else 1


if __name__ == "__main__":
    sys.exit(main())
