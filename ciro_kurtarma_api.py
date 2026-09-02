"""
🚑 CİRO KURTARMA — `ciro` tablosunu `ciro_taslak`tan yeniden inşa eder.

NEDEN VAR (2026-09-02):
  `/api/sistem-sifirla` ucu, PIN'i olmayan bir kapıyla `TRUNCATE TABLE ciro
  CASCADE` çalıştırdı ve canlı ciro tablosu boşaldı. Kaskad yayılmadı:
  `ciro`'ya yabancı anahtarla bağlı tablo yok, dolayısıyla `ciro_taslak` ve
  `kasa_hareketleri` sağlam kaldı.

NİYE KURTARILABİLİYOR:
  Onaylanan her taslak, ürettiği ciro satırının kimliğini `ciro_taslak.ciro_id`
  alanında saklıyordu. Yani silinen satırların ORİJİNAL ID'leri elimizde —
  ciroları eski kimlikleriyle geri yazınca `kasa_hareketleri.kaynak_id`
  bağları kendiliğinden yerine oturur, kırık bağ kalmaz.

⛔ KASAYA DOKUNMAZ — EN ÖNEMLİ KURAL:
  `kasa_hareketleri`'ndeki CIRO satırları SİLİNMEDİ. Kurtarma sırasında kasa
  hareketi de üretilirse ciro kasaya İKİNCİ KEZ girer ve kasa şişer. Bu modül
  YALNIZ `ciro` tablosuna yazar; `insert_kasa_hareketi` hiç çağrılmaz.

🔓 PIN İSTEĞE BAĞLI (sahip kararı 2026-09-02): bu uç geri yükleyicidir —
  siler değil yazar, kasaya dokunmaz, idempotenttir. PIN verilirse doğrulanır
  ve onaylayan deftere yazılır; verilmezse kayıt `sahip_talimati` olarak
  işaretlenir. Kapı kalktı, İZ KALKMADI.

🧪 KURU ÇALIŞTIRMA ZORUNLU:
  `uygula=true` yalnız daha önce aynı parametrelerle kuru çalıştırma yapılmış
  ve LİSTE OKUNMUŞSA anlamlıdır. Uç her iki modda da satır satır listeyi döner;
  para değiştiren toplu işlem, listesi okunmadan çalıştırılmaz.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

router = APIRouter(prefix="/api/ciro-kurtarma", tags=["ciro-kurtarma"])


class KurtarmaBody(BaseModel):
    uygula: bool = False
    onay: Optional[str] = None          # uygula=true için 'EVET_KURTAR'
    onay_pin: Optional[str] = None      # işletme PIN'i (Merve Karabacak)


def _plan_uret(cur) -> Dict[str, Any]:
    """Ne yazılacağını hesaplar — HİÇBİR ŞEY YAZMAZ."""
    cur.execute(
        """
        SELECT t.id AS taslak_id, t.ciro_id, t.sube_id, t.tarih::text AS tarih,
               t.nakit, t.pos, t.online, t.aciklama, t.onay_zamani,
               COALESCE(s.ad, t.sube_id) AS sube_adi
        FROM ciro_taslak t
        LEFT JOIN subeler s ON s.id = t.sube_id
        WHERE t.durum = 'onaylandi' AND COALESCE(t.ciro_id, '') <> ''
        ORDER BY t.tarih, t.sube_id, t.onay_zamani
        """
    )
    taslaklar = [dict(r) for r in (cur.fetchall() or [])]

    # Halihazırda duran ciro satırları — üzerine YAZILMAZ (idempotent kurtarma).
    cur.execute("SELECT id FROM ciro")
    mevcut = {str(r["id"]) for r in (cur.fetchall() or [])}

    # ⚠️ AYNI GÜN + AYNI ŞUBE için birden çok onaylı taslak olabilir (düzeltme
    # sonrası ikinci onay). İkisini de yazmak o günü İKİYE KATLAR. Kural:
    # onay_zamani EN YENİ olan kazanır; elenen satır gizlenmez, RAPORLANIR.
    en_iyi: Dict[tuple, dict] = {}
    elenen: List[dict] = []
    for t in taslaklar:
        anahtar = (t["tarih"], str(t["sube_id"]))
        onceki = en_iyi.get(anahtar)
        if onceki is None:
            en_iyi[anahtar] = t
            continue
        yeni_daha_taze = (t.get("onay_zamani") or "") > (onceki.get("onay_zamani") or "")
        if yeni_daha_taze:
            elenen.append({**onceki, "eleme_nedeni": "daha eski onay"})
            en_iyi[anahtar] = t
        else:
            elenen.append({**t, "eleme_nedeni": "daha eski onay"})

    yazilacak, zaten_var = [], []
    for t in en_iyi.values():
        (zaten_var if str(t["ciro_id"]) in mevcut else yazilacak).append(t)

    def _f(x) -> float:
        return float(x or 0)

    satirlar = [
        {
            "ciro_id": str(t["ciro_id"]),
            "tarih": t["tarih"],
            "sube_id": str(t["sube_id"]),
            "sube_adi": t["sube_adi"],
            "nakit": round(_f(t["nakit"]), 2),
            "pos": round(_f(t["pos"]), 2),
            "online": round(_f(t["online"]), 2),
            "toplam": round(_f(t["nakit"]) + _f(t["pos"]) + _f(t["online"]), 2),
            "aciklama": t.get("aciklama") or "",
            "kaynak": "taslak",
            "taslak_id": str(t["taslak_id"]),
        }
        for t in sorted(yazilacak, key=lambda x: (x["tarih"], str(x["sube_id"])))
    ]

    # ═══ İKİNCİ KAYNAK: RAPOR CACHE ═════════════════════════════════════════
    # Bazı cirolar şube panelinden geçmedi — doğrudan girildi ya da Evo'dan
    # aktarıldı (GECMIS_CIRO_EVO). Taslakları yok, dolayısıyla birinci kaynak
    # onları göremiyor. Ama `rapor_gunluk_sube_ozet` gece batch'inde her gün
    # için nakit/pos/online KIRILIMINI saklıyor — kaybolan tek şey ciro
    # satırıydı, kırılım başka bir defterde duruyordu.
    #
    # ⚠️ Ciro TASLAKTAN geçmiş her kimlik burada DIŞLANIR: birinci kaynak o
    # kayıtlar için zaten karar verdi (mükerrer eleme dahil). İptal edilmiş bir
    # ciroyu ikinci kaynaktan geri diriltmek, elenen mükerreri geri getirirdi.
    cur.execute("SELECT COALESCE(ciro_id,'') AS cid FROM ciro_taslak")
    taslak_kimlikleri = {str(r["cid"]) for r in (cur.fetchall() or []) if r["cid"]}

    cur.execute(
        """
        SELECT kh.kaynak_id::text AS ciro_id, kh.tarih::text AS tarih,
               kh.sube_id::text AS sube_id, kh.tutar::float AS net,
               kh.aciklama,
               COALESCE(s.ad, kh.sube_id) AS sube_adi,
               COALESCE(s.pos_oran, 0)::float AS pos_oran,
               COALESCE(s.online_oran, 0)::float AS online_oran,
               g.ciro_nakit::float  AS c_nakit,
               g.ciro_pos::float    AS c_pos,
               g.ciro_online::float AS c_online
        FROM kasa_hareketleri kh
        LEFT JOIN subeler s ON s.id = kh.sube_id
        LEFT JOIN rapor_gunluk_sube_ozet g
               ON g.sube_id = kh.sube_id AND g.tarih = kh.tarih
        WHERE kh.kaynak_tablo = 'ciro'
          AND COALESCE(kh.durum, 'aktif') = 'aktif'
          AND kh.tutar > 0
        """
    )
    ikinci, kurtarilamayan = [], []
    for r in (cur.fetchall() or []):
        d = dict(r)
        cid = str(d.get("ciro_id") or "")
        if not cid or cid in mevcut or cid in taslak_kimlikleri:
            continue
        n, p, o = _f(d.get("c_nakit")), _f(d.get("c_pos")), _f(d.get("c_online"))
        if (n + p + o) <= 0:
            kurtarilamayan.append({
                "ciro_id": cid, "tarih": d.get("tarih"),
                # ⚠️ sube_id ŞART: üçüncü kaynak (Evo) bu sözlükten okuyor ve
                # `ciro.sube_id` yabancı anahtarlıdır. Taşımayı unutunca canlı
                # ForeignKeyViolation verdi (Key (sube_id)=() bulunamadı).
                "sube_id": str(d.get("sube_id") or ""),
                "sube_adi": d.get("sube_adi"),
                "net": round(_f(d.get("net")), 2),
                "aciklama": (d.get("aciklama") or "")[:80],
                "neden": "rapor cache'inde de kırılım yok",
            })
            continue
        # DOĞRULAMA: kırılımdan hesaplanan net, kasadaki net ile tutuyor mu?
        # Tutmuyorsa satır yine sunulur ama "doğrulanamadı" diye İŞARETLENİR —
        # sessizce doğru saymak, kurtarmayı sahte yeşile çevirirdi.
        hesap_net = n + p * (1 - _f(d.get("pos_oran")) / 100.0) \
                      + o * (1 - _f(d.get("online_oran")) / 100.0)
        fark = round(hesap_net - _f(d.get("net")), 2)
        ikinci.append({
            "ciro_id": cid,
            "tarih": d.get("tarih"),
            "sube_id": str(d.get("sube_id") or ""),
            "sube_adi": d.get("sube_adi"),
            "nakit": round(n, 2), "pos": round(p, 2), "online": round(o, 2),
            "toplam": round(n + p + o, 2),
            "aciklama": (d.get("aciklama") or "Kurtarma: rapor cache kırılımı"),
            "kaynak": "rapor_cache",
            "dogrulama_farki": fark,
            "dogrulandi": abs(fark) <= 1.0,
        })

    # ═══ ÜÇÜNCÜ KAYNAK: EVO ═════════════════════════════════════════════════
    # SAHİP KURALI: "ciro şubeden gelmemişse Evo'dan çağırması lazım."
    # Sistemde bu zaten var (gece `eksik_gun_ciro_tara` sweep'i), ama o yol
    # ONAY BEKLEYEN TASLAK üretir ve onaylanınca `_ciro_insert_aktif_ve_kasa`
    # ile KASAYA DA yazar. Burada kasa satırları zaten duruyor — o yolu
    # kullanmak kasayı İKİYE KATLARDI. Bu yüzden Evo'yu yalnız VERİ KAYNAĞI
    # olarak okuyoruz: kırılımı Evo söyler, yazımı bu modül yapar (ciro'ya).
    #
    # Evo yalnız hâlâ çözülememiş günler için sorgulanır — çalışan kaynak
    # varken dış servise gitmenin anlamı yok (token kırılgan, bkz. Evo token
    # senkron arızası). Evo erişilemezse kurtarma DURMAZ; o satır
    # `kurtarilamayan` listesinde nedeniyle kalır.
    evo_hata = None
    if kurtarilamayan:
        try:
            from datetime import date as _date
            from evo_sync import hs_rapor_sube_bazli, _evvel_sube_evo_payload_eslestir
            _kalan = []
            for x in kurtarilamayan:
                try:
                    _d = _date.fromisoformat(str(x["tarih"])[:10])
                    _ev = hs_rapor_sube_bazli(_d, _d)
                    _p = _evvel_sube_evo_payload_eslestir(x.get("sube_adi") or "",
                                                          (_ev or {}).get("subeler") or {})
                except Exception as e:  # noqa: BLE001
                    evo_hata = str(e); _p = None
                if not _p:
                    x["neden"] = (x.get("neden") or "") + " · Evo'da da bulunamadı"
                    _kalan.append(x)
                    continue
                _n = float(_p.get("nakit") or 0)
                _pz = float(_p.get("kart") or 0)
                if (_n + _pz) <= 0:
                    x["neden"] = (x.get("neden") or "") + " · Evo'da satış yok"
                    _kalan.append(x)
                    continue
                # ⚠️ Evo `online`ı ayırmaz — kart toplamı `pos`a yazılır.
                # Bunu GİZLEMİYORUZ: satır `evo_online_ayrismaz` ile işaretli.
                ikinci.append({
                    "ciro_id": x["ciro_id"], "tarih": x["tarih"],
                    "sube_id": x.get("sube_id") or "", "sube_adi": x.get("sube_adi"),
                    "nakit": round(_n, 2), "pos": round(_pz, 2), "online": 0.0,
                    "toplam": round(_n + _pz, 2),
                    "aciklama": "Kurtarma: Evo satış raporu",
                    "kaynak": "evo",
                    "evo_online_ayrismaz": True,
                    "dogrulama_farki": None,
                    "dogrulandi": False,
                })
            kurtarilamayan[:] = _kalan
        except Exception as e:  # noqa: BLE001
            evo_hata = str(e)

    # 🛡️ ŞUBESİZ SATIR YAZILMAZ: `ciro.sube_id` yabancı anahtarlıdır; boş
    # değer TÜM transaction'ı düşürür ve 279 satırın hiçbiri yazılmaz.
    # Tek bir çözümsüz satır yüzünden kurtarmanın tamamını kaybetmeyelim —
    # o satır listeden çıkar, `kurtarilamayan`a nedeniyle düşer.
    _subesiz = [x for x in ikinci if not str(x.get("sube_id") or "").strip()]
    for x in _subesiz:
        kurtarilamayan.append({
            "ciro_id": x.get("ciro_id"), "tarih": x.get("tarih"),
            "sube_adi": x.get("sube_adi"), "net": x.get("toplam"),
            "neden": "şube kimliği yok — ciro.sube_id yabancı anahtarı boş kabul etmez",
        })
    ikinci[:] = [x for x in ikinci if str(x.get("sube_id") or "").strip()]

    satirlar.extend(sorted(ikinci, key=lambda x: (x["tarih"], str(x["sube_id"]))))
    satirlar.sort(key=lambda x: (x["tarih"], str(x["sube_id"])))

    # Kasa tarafı: bağ tutacak mı? Kurtarma sonrası kırık kalan var mı?
    cur.execute(
        """
        SELECT COUNT(*) AS adet, COALESCE(SUM(tutar), 0)::float AS net
        FROM kasa_hareketleri
        WHERE kaynak_tablo = 'ciro' AND COALESCE(durum, 'aktif') = 'aktif'
        """
    )
    kasa = dict(cur.fetchone() or {})
    hedef = {s["ciro_id"] for s in satirlar} | mevcut
    cur.execute(
        """
        SELECT COUNT(*) AS adet FROM kasa_hareketleri
        WHERE kaynak_tablo = 'ciro' AND COALESCE(durum, 'aktif') = 'aktif'
          AND NOT (kaynak_id = ANY(%s))
        """,
        (list(hedef) or [""],),
    )
    yetim = int((cur.fetchone() or {}).get("adet") or 0)

    return {
        "satirlar": satirlar,
        "yazilacak_adet": len(satirlar),
        "kaynak_dagilimi": {
            "taslak": sum(1 for x in satirlar if x.get("kaynak") == "taslak"),
            "rapor_cache": sum(1 for x in satirlar if x.get("kaynak") == "rapor_cache"),
            "evo": sum(1 for x in satirlar if x.get("kaynak") == "evo"),
            "dogrulanamayan": sum(1 for x in satirlar
                                  if x.get("kaynak") in ("rapor_cache", "evo")
                                  and not x.get("dogrulandi")),
        },
        "evo_hata": evo_hata,
        # Hâlâ kurtarılamayanlar GİZLENMEZ: elle girilecek olan tam olarak bunlar.
        "kurtarilamayan": kurtarilamayan,
        "zaten_duran_adet": len(zaten_var),
        "elenen_mukerrer": [
            {
                "tarih": e["tarih"], "sube_adi": e["sube_adi"],
                "ciro_id": str(e["ciro_id"]), "neden": e["eleme_nedeni"],
                "toplam": round(_f(e["nakit"]) + _f(e["pos"]) + _f(e["online"]), 2),
            }
            for e in elenen
        ],
        "toplamlar": {
            "nakit": round(sum(s["nakit"] for s in satirlar), 2),
            "pos": round(sum(s["pos"] for s in satirlar), 2),
            "online": round(sum(s["online"] for s in satirlar), 2),
            "brut": round(sum(s["toplam"] for s in satirlar), 2),
        },
        "kasa_ciro_satiri": {
            "adet": int(kasa.get("adet") or 0),
            "net_toplam": round(float(kasa.get("net") or 0), 2),
            "not": "Bu satırlara DOKUNULMAZ — kurtarma kasaya yazmaz.",
        },
        "kurtarma_sonrasi_yetim_kasa_satiri": yetim,
    }


@router.post("")
def ciro_kurtar(body: KurtarmaBody) -> Dict[str, Any]:
    """Kuru çalıştırma (varsayılan) veya uygulama. Kasaya asla yazmaz."""
    with db() as (conn, cur):
        plan = _plan_uret(cur)

        if not body.uygula:
            plan["kuru"] = True
            plan["mesaj"] = (
                f"KURU ÇALIŞTIRMA — hiçbir şey yazılmadı. "
                f"{plan['yazilacak_adet']} ciro satırı geri yazılacak "
                f"({plan['toplamlar']['brut']:,.2f} ₺ brüt)."
            )
            return plan

        if (body.onay or "").strip() != "EVET_KURTAR":
            raise HTTPException(400, "Onay gerekli: onay='EVET_KURTAR'")

        # ── YETKİ: PIN İSTEĞE BAĞLI (sahip kararı, 2026-09-02) ──────────────
        # Bu uç, `sistem-sifirla` gibi YIKICI değil GERİ YÜKLEYİCİDİR:
        #   · yalnız EKSİK satırı INSERT eder (ON CONFLICT DO NOTHING)
        #   · hiçbir satırı SİLMEZ veya GÜNCELLEMEZ
        #   · kasaya YAZMAZ (insert_kasa_hareketi hiç çağrılmaz)
        #   · idempotenttir — iki kez çalışsa ikinci turda 0 satır yazar
        #   · verisi kullanıcıdan değil, sistemin KENDİ defterlerinden gelir
        #     (ciro_taslak · rapor cache · Evo)
        # Yıkıcı uçtaki PIN'i buraya da koymuştum; sahip "kaldır" dedi ve
        # gerekçe sağlam: yok edeni durduran kapı, geri getireni durdurmamalı.
        # ⚠️ Kapı kalkıyor ama İZ KALKMIYOR — kim/nasıl çalıştırdı deftere yazılır.
        onayci = {"id": None, "ad_soyad": "(PIN'siz — sahip talimatı)"}
        _yetki_kaynak = "sahip_talimati"
        if (body.onay_pin or "").strip():
            from operasyon_merkez_api import _isletme_onay_dogrula
            onayci = _isletme_onay_dogrula(cur, body.onay_pin)  # PIN hatalı → 403
            _yetki_kaynak = "isletme_pin"

        yazilan = 0
        for s in plan["satirlar"]:
            # ⚠️ ON CONFLICT DO NOTHING: uç iki kez çağrılsa da satır çoğalmaz.
            # `toplam` GENERATED kolon — yazılmaz, veritabanı üretir.
            cur.execute(
                """
                INSERT INTO ciro (id, tarih, sube_id, nakit, pos, online, aciklama, durum)
                VALUES (%s, %s::date, %s, %s, %s, %s, %s, 'aktif')
                ON CONFLICT (id) DO NOTHING
                """,
                (s["ciro_id"], s["tarih"], s["sube_id"], s["nakit"], s["pos"],
                 s["online"], s["aciklama"] or "Kurtarma: taslaktan geri yazıldı"),
            )
            yazilan += cur.rowcount or 0

        from kasa_service import audit
        audit(cur, "ciro", "KURTARMA", "CIRO_KURTARMA",
              yeni={"yazilan": yazilan, "planlanan": plan["yazilacak_adet"],
                    "brut": plan["toplamlar"]["brut"],
                    "kaynak_dagilimi": plan.get("kaynak_dagilimi"),
                    "kasaya_yazilmadi": True},
              aktor=onayci.get("ad_soyad"),
              aktor_id=(str(onayci.get("id")) if onayci.get("id") else None),
              aktor_kaynak=_yetki_kaynak)

        plan["kuru"] = False
        plan["yazilan_adet"] = yazilan
        plan["onaylayan"] = onayci.get("ad_soyad")
        plan["yetki_kaynak"] = _yetki_kaynak
        plan["mesaj"] = f"{yazilan} ciro satırı geri yazıldı. Kasaya dokunulmadı."
        return plan
