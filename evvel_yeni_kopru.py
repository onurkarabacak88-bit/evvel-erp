"""🌉 EVVEL YENİ · ESKİ SİSTEM KÖPRÜSÜ (geçiş yardımcıları) — TEK DOSYA.

Eski Evvel tablolarını (operasyon_defter, siparis_urun …) okuyan AYRIŞTIRICILAR burada toplanır; modüller kendi kopyasını
tutmaz (sahip 2026-10-19: "sistem bunu bir yerde yapmış, tekrar yapıyor olmayalım"). 1 Kasım kesiminden sonra (KESIM_LISTESI)
okuyucular yeni deftere geçince bu dosya SİLİNİR — köprü tek yerde olduğu için kesim tek adımdır.
Bir manifest modülü DEĞİL (router yok, tablo yok, durum yok) — saf yardımcı; hiçbir Evvel Yeni modülüne bağımlı değil.
"""
import json


def urun_ac_parcala(aciklama: str) -> list:
    """Eski panel Ürün Aç kaydı (operasyon_defter URUN_AC_JSON / URUN_KULLANIMA_AL_JSON) → [(urun_id, urun_ad, adet)].
    adet > 0 olan her kalem döner (urun_id boş olabilir — kimliği gereken okuyucu kendisi süzer). Bozuk metin sessizce boş liste."""
    raw = aciklama or ""
    for on in ("URUN_AC_JSON:", "URUN_KULLANIMA_AL_JSON:"):
        if raw.startswith(on):
            raw = raw[len(on):]
            break
    else:
        return []
    try:
        obj = json.loads(raw.split(" | ", 1)[0].strip())
    except Exception:  # noqa: BLE001
        return []
    out = []
    for it in (obj.get("kalemler") or []) if isinstance(obj, dict) else []:
        if not isinstance(it, dict):
            continue
        try:
            adet = max(0, int(it.get("adet") or 0))
        except (TypeError, ValueError):
            adet = 0
        if adet:
            out.append((str(it.get("urun_id") or "").strip(), str(it.get("urun_ad") or "").strip(), adet))
    return out
