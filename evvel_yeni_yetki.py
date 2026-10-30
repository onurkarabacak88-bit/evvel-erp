"""🔐 EVVEL YENİ · ROL / İZİN KAPISI (sahip 30 Eki: "Mehmet Uçak müdürüm — bütün basamakları tek tek, görme izni, sök-tak, alt basamaklar
dahil" + "telefondan bağlandığında da bu kapıya göre göstermeli" + "bugün yap"). L4b: Codex + Fable (kurgu) · Opus (kayıtsız kullanıcı).

TEK SÖZLÜK (SOZLUK): her basamak {anahtar, mod, grup, ad, tur: ekran|islem, bagli, sayfa, hassas}. Ekran → sayfa kimliği (ön yüz menüsü,
sekmeleri ve /cep kartları BUNDAN süzülür — ikinci liste yok). Modül kapalıysa (evvel_yeni_moduller.acik) o modülün basamakları etkisiz.
SUNUCU YOLLARI (YOLLAR): merkez ucu → gereken anahtar(lar). "*" = oturumlu her merkez kullanıcısı (ortak liste), None = kapı DIŞI
(şube PC / personel telefonu — cihaz kimliği). Eşlenmemiş merkez ucu = KAPALI (Codex).
KİŞİ İZNİ (ey_yetki): kullanici_id → {sahip, izinler{anahtar: gor|yap}}. Kural (Opus): ortak yönetim şifresi (kimliksiz jeton) = HEPSİ
(sahibin acil kapısı) · sahip kaydı = HEPSİ · kaydı olmayan / okunamayan kimlikli hesap = HİÇBİRİ. Ekran yalnız 'gor', işlem yalnız 'yap';
işlem bağlı olduğu ekranı da ister.
KİP (ey_ayar 'yetki_kapi'): 'gozlem' (varsayılan — engellemez, "burada kapalı olurdu" sayar) | 'zorla' (403). Zorla'ya geçiş şartı:
eşlenmemiş aktif kimlikli hesap 0 + en az 1 sahip kaydı. EY_KAPI ortam değişkenine BAĞLI DEĞİL (Codex).
"""

import json
import logging
import re
import threading
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from database import db

log = logging.getLogger(__name__)

# ───────────────────────── SÖZLÜK ─────────────────────────
# (anahtar, mod, ad, tur e|i, hassas, bagli ekran, sayfa kimliği[ler])
_S = [
    # genel (çekirdek): ana sayfa + Bekleyen işler sekmeleri
    ("ana", "kasa", "Ana sayfa (kasa özeti)", "e", 1, None, ["kasam"]),
    ("isler.kasa", "genel", "Bekleyen işler › Kasa & kapanış", "e", 1, None, ["isler_kasa"]),
    ("isler.kasa.islem", "genel", "Kasa işlerini kapat (POS sıfır, geç kapanış, Gördüm)", "i", 1, "isler.kasa", []),
    ("isler.siparis", "siparis", "Bekleyen işler › Sipariş yönlendirme", "e", 0, None, ["isler_siparis"]),
    ("isler.odeme", "genel", "Bekleyen işler › Ödemeler", "e", 1, None, ["isler_odeme"]),
    ("isler.tedarik", "genel", "Bekleyen işler › Tedarik & depo", "e", 0, None, ["isler_tedarik"]),
    ("isler.personel", "genel", "Bekleyen işler › Personel", "e", 0, None, ["isler_personel"]),
    ("isler.mulk", "mulk", "Bekleyen işler › Kira hesabı", "e", 1, None, ["isler_kira"]),
    ("isler.notlar", "panel", "Bekleyen işler › Şube notları", "e", 0, None, ["isler_not"]),
    ("isler.notlar.islem", "panel", "Şube notunu 'Gördüm' yap", "i", 0, "isler.notlar", []),
    # kasa
    ("kasa.kasam", "kasa", "Kasam", "e", 1, None, ["kasam"]),
    ("kasa.dukkan", "kasa", "Dükkân nakitleri", "e", 1, None, ["subeler"]),
    ("kasa.evler", "kasa", "Evler (Onur · Fatma)", "e", 1, None, ["evler"]),
    ("kasa.banka", "kasa", "Bankalar", "e", 1, None, ["bankalar"]),
    ("kasa.hareket", "kasa", "Günlük hareketler", "e", 1, None, ["hareketler"]),
    ("kasa.uyari", "kasa", "Uyarılar", "e", 0, None, ["uyarilar"]),
    ("kasa.teslim", "kasa", "Teslim onayları", "e", 1, None, ["teslim"]),
    ("kasa.teslim.islem", "kasa", "Teslimi al / düzelt", "i", 1, "kasa.teslim", []),
    ("kasa.mutabakat", "kasa", "Banka mutabakatı", "e", 1, None, ["banka"]),
    ("kasa.fark", "kasa", "Açık farklar", "e", 1, None, ["farklar"]),
    ("kasa.islem", "kasa", "Kasa hareketi gir", "i", 1, "kasa.hareket", []),
    ("kasa.iptal", "kasa", "Kasa hareketi iptal", "i", 1, "kasa.hareket", []),
    ("kasa.donem", "kasa", "Dönem kapat / eski sistemden aktar", "i", 1, "kasa.kasam", []),
    ("gelir.liste", "gelir", "Gelirlerim", "e", 1, None, ["gelirler"]),
    ("gider.liste", "gider", "Giderlerim", "e", 1, None, ["giderler"]),
    ("gider.siniflandir", "gider", "Gideri sınıflandır", "i", 0, "gider.liste", []),
    ("fis.kontrol", "fis", "Anlık gider fiş kontrol", "e", 0, None, ["fis_kontrol"]),
    ("fis.isaretle", "fis", "Fişi işaretle", "i", 0, "fis.kontrol", []),
    ("odeme.defter", "odeme", "Ödeme defteri", "e", 1, None, ["odemeler", "odeme_defteri"]),
    ("odeme.gir", "odeme", "Ödeme / gider gir", "i", 1, "odeme.defter", []),
    ("odeme.patron", "odeme", "Patron harcamaları", "e", 1, None, ["patron_harcama"]),
    ("odeme.patron.islem", "odeme", "Patron harcaması ata", "i", 1, "odeme.patron", []),
    ("kira.takvim", "kira", "Kira takvimi", "e", 1, None, ["kira_takvimi"]),
    ("fatura.dagit", "fatura", "Faturaları dağıt", "e", 1, None, ["fatura_dagit"]),
    ("fatura.islem", "fatura", "Fatura oku / kaydet / kural sil", "i", 1, "fatura.dagit", []),
    ("kredi.takvim", "kredi", "Kredi takvimi", "e", 1, None, ["kredi_takvimi"]),
    ("kredi.islem", "kredi", "Kredi kaydet / düzelt", "i", 1, "kredi.takvim", []),
    ("kart.liste", "kart", "Kartlar", "e", 1, None, ["kartlar"]),
    ("kart.takvim", "kart", "Kart ödeme takvimi", "e", 1, None, ["kart_takvimi"]),
    ("kart.islem", "kart", "Kart teyit / pasif yap", "i", 1, "kart.liste", []),
    ("toptanci.liste", "toptanci", "Toptancılar", "e", 1, None, ["toptancilar"]),
    ("toptanci.teslim", "toptanci", "Teslim gir / tutar onayla / iptal", "i", 1, "toptanci.liste", []),
    ("toptanci.belge", "toptanci", "Belge ekle / kaldır, fatura iste", "i", 0, "toptanci.liste", []),
    ("toptanci.fiyat", "toptanci", "Ürün fiyatları", "e", 0, None, ["urun_fiyatlari"]),
    ("toptanci.fiyat.islem", "toptanci", "Fiyat kaydet", "i", 0, "toptanci.fiyat", []),
    ("depo.nerede", "depo", "Nerede?", "e", 0, None, ["depo_nerede"]),
    ("depo.sevk", "depo", "Sevk et", "e", 0, None, ["depo_sevk"]),
    ("depo.sevk.islem", "depo", "Sevk et / sevk iptal", "i", 0, "depo.sevk", []),
    ("depo.yolda", "depo", "Yoldakiler", "e", 0, None, ["depo_yolda"]),
    ("depo.yolda.islem", "depo", "Merkez kabul", "i", 0, "depo.yolda", []),
    ("depo.fark", "depo", "Sevk farkları", "e", 0, None, ["depo_fark"]),
    ("depo.fark.islem", "depo", "Farkı çöz", "i", 0, "depo.fark", []),
    ("depo.sayim", "depo", "Depo sayımı", "e", 0, None, ["depo_sayim"]),
    ("depo.sayim.islem", "depo", "Sayım gir", "i", 0, "depo.sayim", []),
    ("siparis.liste", "siparis", "Siparişler", "e", 0, None, ["siparis_yon"]),
    ("siparis.islem", "siparis", "Yönlendir / ilet / iptal", "i", 0, "siparis.liste", []),
    ("kazanc.liste", "kazanc", "Şube kazancı", "e", 1, None, ["kazanc"]),
    ("maas.maaslar", "maas", "Maaşlar", "e", 1, None, ["maaslar"]),
    ("maas.duzelt", "maas", "Hak ediş düzelt", "i", 1, "maas.maaslar", []),
    ("maas.kestam", "maas", "Geç kalma / gelmeyen gün: Kes / Tam al", "i", 1, "maas.maaslar", []),
    ("maas.onay", "maas", "Maaşı onayla / onayı kaldır", "i", 1, "maas.maaslar", []),
    ("maas.yoklama", "maas", "Günlük yoklama", "e", 0, None, ["personel_yoklama"]),
    ("maas.takvim", "maas", "Personel takvimi", "e", 0, None, ["personel_takvim"]),
    ("maas.takvim.islem", "maas", "Takvim kararı (izin / ayrıldı)", "i", 0, "maas.takvim", []),
    ("avans.liste", "avans", "Avans talepleri", "e", 1, None, ["avans_talepleri"]),
    ("avans.islem", "avans", "Avansı onayla / reddet / kapat", "i", 1, "avans.liste", []),
    ("vardiya.plan", "vardiya", "Vardiya planı", "e", 0, None, ["vardiya_plani"]),
    ("vardiya.islem", "vardiya", "Vardiya yaz / yayınla / izin gir", "i", 0, "vardiya.plan", []),
    ("vardiya.ayar", "vardiya", "Vardiya ayarları", "i", 0, "vardiya.plan", []),
    ("yoklama.telefon", "yoklama", "Telefonlar (cihaz bağlama)", "e", 0, None, ["personel_telefon"]),
    ("yoklama.telefon.islem", "yoklama", "Link üret / cihaz onayla / iptal, konum muafiyeti, çıkışı yaz", "i", 0, "yoklama.telefon", []),
    ("yoklama.mola", "yoklama", "Yemek molaları", "e", 0, None, ["personel_mola"]),
    ("yoklama.mola.islem", "yoklama", "Molayı düzelt / hak ver", "i", 1, "yoklama.mola", []),
    ("yoklama.devir", "yoklama", "Devirler", "e", 0, None, ["personel_devir"]),
    ("yoklama.devir.islem", "yoklama", "Devri kapat", "i", 1, "yoklama.devir", []),
    ("mulk.ev", "mulk", "Ev kiraları", "e", 1, None, ["mulk_takvim"]),
    ("mulk.borc", "mulk", "İşletmelerin borcu", "e", 1, None, ["mulk_borc"]),
    ("mulk.uyari", "mulk", "Uyarılar", "e", 1, None, ["mulk_uyari"]),
    ("mulk.islem", "mulk", "Kaydet / tahsilat / bağla / karar", "i", 1, "mulk.ev", []),
    ("bar.sayim", "bar", "Bar sayımı", "e", 0, None, ["bar_sayim"]),
    ("satis.kontrol", "satis", "Satış kontrolü", "e", 1, None, ["satis_kontrol"]),
    ("satis.beklenen", "satis", "Beklenen satış", "e", 1, None, ["satis_beklenen"]),
    ("satis.devir", "satis", "Kasa devir defteri", "e", 1, None, ["devir_defteri"]),
    ("tanim.sube", "tanim", "Şubeler", "e", 0, None, ["tanim_sube"]),
    ("tanim.sube.islem", "tanim", "Şube ekle / değiştir", "i", 0, "tanim.sube", []),
    ("tanim.personel", "tanim", "Personel tanımı", "e", 1, None, ["tanim_personel"]),
    ("tanim.personel.islem", "tanim", "Personel ekle / ücret değiştir / pasif yap", "i", 1, "tanim.personel", []),
    ("tanim.banka", "tanim", "Bankalar", "e", 1, None, ["tanim_banka"]),
    ("tanim.banka.islem", "tanim", "Banka ekle / değiştir", "i", 1, "tanim.banka", []),
    ("tanim.kart", "tanim", "Kart tanımı", "e", 1, None, ["tanim_kart"]),
    ("tanim.kart.islem", "tanim", "Kart ekle / değiştir", "i", 1, "tanim.kart", []),
    ("tanim.toptanci", "tanim", "Toptancı tanımı", "e", 0, None, ["tanim_toptanci"]),
    ("tanim.toptanci.islem", "tanim", "Toptancı ekle / değiştir", "i", 0, "tanim.toptanci", []),
    ("urun.katalog", "urun", "Ürünler", "e", 0, None, ["urunler"]),
    ("urun.islem", "urun", "Ürün / kategori kaydet", "i", 0, "urun.katalog", []),
    ("sistem.durum", "cekirdek", "Sistem durumu", "e", 0, None, ["sistem_durumu"]),
    ("sistem.islem", "cekirdek", "Son aktarım, pilot şube, arka plan işini çalıştır", "i", 1, "sistem.durum", []),
]
SOZLUK: List[dict] = [{"anahtar": a, "mod": m, "ad": ad, "tur": "ekran" if t == "e" else "islem", "hassas": bool(h), "bagli": b, "sayfa": s}
                      for a, m, ad, t, h, b, s in _S]
_SOZ = {x["anahtar"]: x for x in SOZLUK}
assert len(_SOZ) == len(SOZLUK), "izin anahtarı iki kez yazılmış"
assert all(x["bagli"] in _SOZ and _SOZ[x["bagli"]]["tur"] == "ekran" for x in SOZLUK if x["bagli"]), "bağlı ekran sözlükte yok"

# İş satırı grubu → Bekleyen işler anahtarı (KasaModulu IS_GRUPLARI ile aynı grup adları)
# Kasa cep türü → o cebi gösteren ekran (Codex P1: tek kasa izni bütün cepleri açmasın)
CEP_TUR_ANAHTAR = {"sube": "kasa.dukkan", "ev": "kasa.evler", "banka": "kasa.banka", "hesap": "kasa.banka"}

IS_GRUP_ANAHTAR = {"kasa": "isler.kasa", "siparis": "isler.siparis", "odeme": "isler.odeme", "tedarik": "isler.tedarik",
                   "personel": "isler.personel", "kira": "isler.mulk", "not": "isler.notlar"}

# ───────────────────────── SUNUCU YOLLARI ─────────────────────────
# (yöntem, kalıp /api/evvel-yeni sonrası, gereken anahtar(lar) "a|b" = biri yeter · "*" ortak · None kapı dışı)
_Y = [
    ("GET", "/moduller", "*"), ("GET", "/moduller/pilot", "sistem.durum"), ("POST", "/moduller/pilot", "sistem.islem"),
    ("GET", "/moduller/gecis", None), ("GET", "/moduller/gecis/{x}", None), ("GET", "/moduller/eski-kullanim", "sistem.durum"),
    ("GET", "/moduller/gorevler", "sistem.durum"), ("POST", "/moduller/gorevler/{x}/calistir", "sistem.islem"),
    ("GET", "/moduller/kesim", "sistem.durum"), ("POST", "/moduller/kesim/calistir", "sistem.islem"),
    ("GET", "/yetki/ben", "*"), ("GET", "/yetki/sozluk", "*"), ("GET", "/yetki/kullanicilar", "*"), ("POST", "/yetki/kisi/{x}", "*"),
    ("GET", "/yetki/gozlem", "*"), ("POST", "/yetki/kip", "*"),   # sahiplik ucun İÇİNDE denetlenir
    ("GET", "/olay/kontrol", "sistem.durum"),
    # avans
    ("GET", "/avans/talepler", "avans.liste|isler.personel"), ("POST", "/avans/{x}/{y}", "avans.islem"),
    ("GET", "/bar/ozet", "bar.sayim"),
    # depo
    ("GET", "/depo/ozet", "depo.nerede|depo.sevk|depo.yolda|depo.fark|depo.sayim"), ("GET", "/depo/iz", "depo.nerede|depo.sayim"),
    ("GET", "/depo/yolda", "depo.yolda|depo.fark|isler.tedarik"), ("GET", "/depo/sevkler", "depo.sevk|depo.yolda|depo.fark"),
    ("POST", "/depo/sayim", "depo.sayim.islem"), ("POST", "/depo/yolda/{x}/merkez-kabul", "depo.yolda.islem"),
    ("POST", "/depo/yolda/{x}/fark-coz", "depo.fark.islem"), ("POST", "/depo/sevk", "depo.sevk.islem"),
    ("POST", "/depo/sevk/{x}/iptal", "depo.sevk.islem"), ("POST", "/depo/senkron", "sistem.islem"),
    # fatura / fiş
    ("POST", "/fatura/oku", "fatura.islem"), ("POST", "/fatura/kaydet", "fatura.islem"), ("GET", "/fatura/kurallar", "fatura.dagit"),
    ("POST", "/fatura/kural-sil", "fatura.islem"), ("GET", "/fis/liste", "fis.kontrol"), ("POST", "/fis/isaretle", "fis.isaretle"),
    ("GET", "/gelir/ozet", "gelir.liste"), ("GET", "/gider/ozet", "gider.liste"), ("POST", "/gider/siniflandir", "gider.siniflandir"),
    # kart
    ("GET", "/kart/takvim", "kart.takvim|isler.odeme"), ("GET", "/kart/ozet", "kart.liste|kart.takvim|tanim.kart"),
    ("POST", "/kart/{x}/teyit", "kart.islem"), ("POST", "/kart/teyit/{x}/sil", "kart.islem"),
    # kasa (/kasa/durum ortak: içerik izne göre BUDANIR — Bekleyen işler + ana sayfa)
    ("GET", "/kasa/durum", "*"), ("GET", "/kasa/cep/{x}", "kasa.kasam|kasa.dukkan|kasa.evler|kasa.banka|kasa.hareket"),
    ("GET", "/kasa/teslimler", "kasa.teslim"), ("GET", "/kasa/banka-mutabakat", "kasa.mutabakat"),
    ("GET", "/kasa/acik-defter", "kasa.fark"), ("GET", "/kasa/fark/{x}", "kasa.fark"),
    ("POST", "/kasa/hareket", "kasa.islem"), ("POST", "/kasa/hareket/{x}/onay", "kasa.teslim.islem|kasa.islem"),
    ("POST", "/kasa/hareket/{x}/iptal", "kasa.iptal|odeme.gir"), ("POST", "/kasa/aktar", "kasa.donem"),
    ("POST", "/kasa/hareket/{x}/teslim-duzelt", "kasa.teslim.islem"), ("POST", "/kasa/onay-toplu", "kasa.islem"),
    ("POST", "/kasa/donem", "kasa.donem"),
    ("POST", "/kasa/evo-kabul", "isler.kasa.islem"), ("POST", "/kasa/pos-sifir-kabul", "isler.kasa.islem"),
    ("POST", "/kasa/panel-sayim", "isler.kasa.islem"), ("POST", "/kasa/gec-kapanis", "isler.kasa.islem"),
    ("POST", "/kasa/kapanis-uyari-gordum", "isler.kasa.islem"), ("POST", "/kasa/kapanis-sonradan-gordum", "isler.kasa.islem"),
    ("GET", "/kazanc/ozet", "kazanc.liste"),
    # kira / kredi
    ("GET", "/kira/tutar", "kira.takvim|odeme.defter"), ("GET", "/kira/takvim", "kira.takvim|isler.odeme"),
    ("POST", "/kira/{x}", "odeme.gir"),
    ("GET", "/kredi/liste", "kredi.takvim"), ("GET", "/kredi/takvim", "kredi.takvim|isler.odeme"),
    ("POST", "/kredi", "kredi.islem"), ("POST", "/kredi/{x}", "kredi.islem"),
    # maaş
    ("GET", "/maas/liste", "maas.maaslar"), ("POST", "/maas/{x}/{y}/gec-karar", "maas.kestam"),
    ("POST", "/maas/{x}/{y}/onay", "maas.onay"), ("POST", "/maas/{x}/{y}", "maas.duzelt"),
    ("GET", "/maas/takvim", "maas.takvim"), ("POST", "/maas/takvim-karar", "maas.takvim.islem"),
    ("GET", "/maas/yoklama", "maas.yoklama"),
    # mülk
    ("GET", "/mulk/takvim", "mulk.ev|isler.mulk"), ("GET", "/mulk/borc", "mulk.borc"), ("GET", "/mulk/uyarilar", "mulk.uyari"),
    ("GET", "/mulk/baglanmamis", "mulk.ev|mulk.uyari"), ("POST", "/mulk", "mulk.islem"), ("POST", "/mulk/tahsilat", "mulk.islem"),
    ("POST", "/mulk/karar", "mulk.islem"), ("POST", "/mulk/bagla", "mulk.islem"),
    # ödeme
    ("GET", "/odeme/listeler", "odeme.defter|odeme.patron|avans.islem"), ("GET", "/odeme/liste", "odeme.defter"),
    ("GET", "/odeme/personel-durum", "odeme.defter|maas.maaslar"), ("GET", "/odeme/patron", "odeme.patron"),
    ("POST", "/odeme", "odeme.gir"), ("POST", "/odeme/{x}/duzelt", "odeme.gir"),
    ("POST", "/odeme/personel-ucret", "tanim.personel.islem"), ("POST", "/odeme/patron-ata", "odeme.patron.islem"),
    # şube paneli — merkezin Bekleyen işler eylemleri kapıda; geri kalanı şube PC (cihaz) → kapı dışı
    ("POST", "/panel/ara-sayim-gordum", "isler.kasa.islem"), ("POST", "/panel/gec-kapanis", "isler.kasa.islem"),
    ("POST", "/panel/kapanis-uyari-gordum", "isler.kasa.islem"), ("POST", "/panel/not-gordum", "isler.notlar.islem"),
    ("*", "/panel/{x}", None), ("*", "/panel/{x}/{y}", None), ("*", "/panel/{x}/{y}/{z}", None), ("*", "/panel/{x}/{y}/{z}/{w}", None),
    # satış
    ("GET", "/satis/kontrol", "satis.kontrol"), ("GET", "/satis/gun", "satis.beklenen"), ("GET", "/satis/devir-defteri", "satis.devir"),
    # sipariş
    ("GET", "/siparis/liste", "siparis.liste|isler.siparis"), ("POST", "/siparis/deneme-temizle", "sistem.islem"),
    ("POST", "/siparis/{x}/{y}", "siparis.islem"), ("POST", "/siparis/{x}/kalem/{y}/{z}", "siparis.islem"),
    # tanımlar (liste ortak: içerik BUDANIR)
    ("GET", "/tanim/liste", "*"),
    ("POST", "/tanim/sube", "tanim.sube.islem"), ("POST", "/tanim/sube/{x}", "tanim.sube.islem"),
    ("POST", "/tanim/personel", "tanim.personel.islem"), ("POST", "/tanim/personel/{x}", "tanim.personel.islem"),
    ("POST", "/tanim/kart", "tanim.kart.islem"), ("POST", "/tanim/kart/{x}", "tanim.kart.islem|kart.islem"),
    ("POST", "/tanim/banka", "tanim.banka.islem"), ("POST", "/tanim/banka/{x}", "tanim.banka.islem"),
    ("POST", "/tanim/toptanci", "tanim.toptanci.islem"), ("POST", "/tanim/toptanci/{x}", "tanim.toptanci.islem"),
    # toptancı
    ("POST", "/toptanci/fatura-iste", "toptanci.belge"), ("GET", "/toptanci/ozet", "toptanci.liste|isler.tedarik|isler.odeme"),
    ("POST", "/toptanci/teslim", "toptanci.teslim"), ("POST", "/toptanci/teslim/{x}/tutar", "toptanci.teslim"),
    ("POST", "/toptanci/teslim/{x}/belge", "toptanci.belge"), ("GET", "/toptanci/teslim/{x}/belgeler", "toptanci.liste"),
    ("GET", "/toptanci/teslim/{x}/belge-telefon", None), ("POST", "/toptanci/teslim/{x}/belge-telefon", None),
    ("GET", "/toptanci/belge/{x}", "toptanci.liste"), ("POST", "/toptanci/belge/{x}/kaldir", "toptanci.belge"),
    ("POST", "/toptanci/teslim/{x}/iptal", "toptanci.teslim"), ("GET", "/toptanci/fiyatlar", "toptanci.fiyat|urun.katalog"),
    ("POST", "/toptanci/fiyat", "toptanci.fiyat.islem"),
    # ürün (katalog ortak liste — sipariş / depo / sayım seçicileri)
    ("GET", "/urun/katalog", "*"), ("GET", "/urun/{x}/iz", "urun.katalog|depo.nerede"),
    ("POST", "/urun/kategori", "urun.islem"), ("POST", "/urun/kategori/{x}", "urun.islem"),
    ("POST", "/urun", "urun.islem"), ("POST", "/urun/{x}", "urun.islem"),
    # vardiya
    ("GET", "/vardiya/gecmis", "vardiya.plan"), ("GET", "/vardiya/hafta", "vardiya.plan|maas.takvim"), ("GET", "/vardiya/ayar", "vardiya.plan"),
    ("POST", "/vardiya/ayar", "vardiya.ayar"), ("POST", "/vardiya/kalip", "vardiya.ayar"), ("POST", "/vardiya/kalip/{x}/degistir", "vardiya.ayar"),
    ("POST", "/vardiya/geri-al", "vardiya.islem"), ("POST", "/vardiya/plan", "vardiya.islem"), ("POST", "/vardiya/izin", "vardiya.islem"),
    ("POST", "/vardiya/izin/{x}/kaldir", "vardiya.islem"), ("POST", "/vardiya/taslak-temizle", "vardiya.islem"),
    ("POST", "/vardiya/plan/{x}/degistir", "vardiya.islem"), ("POST", "/vardiya/plan/{x}/iptal", "vardiya.islem"),
    ("POST", "/vardiya/hafta-kopyala", "vardiya.islem"), ("POST", "/vardiya/yayinla", "vardiya.islem"), ("POST", "/vardiya/eski-kopya", "vardiya.islem"),
    # yoklama — merkez uçları kapıda (önek istisnası yetki değildir — Codex); telefon / şube uçları kapı dışı
    ("POST", "/yoklama/cihaz/davet", "yoklama.telefon.islem"), ("POST", "/yoklama/cihaz/{x}/onayla", "yoklama.telefon.islem"),
    ("POST", "/yoklama/cihaz/{x}/iptal", "yoklama.telefon.islem"), ("GET", "/yoklama/cihazlar", "yoklama.telefon"),
    ("POST", "/yoklama/personel/{x}/konum-muaf", "yoklama.telefon.islem"), ("POST", "/yoklama/duzelt", "yoklama.telefon.islem"),
    ("GET", "/yoklama/gunler", "yoklama.telefon|maas.yoklama"), ("GET", "/yoklama/molalar", "yoklama.mola"),
    ("POST", "/yoklama/mola/{x}/duzelt", "yoklama.mola.islem"), ("POST", "/yoklama/mola/{x}/hak-ver", "yoklama.mola.islem"),
    ("POST", "/yoklama/mola/{x}/gordum", "yoklama.mola.islem"), ("GET", "/yoklama/devirler", "yoklama.devir"),
    ("POST", "/yoklama/devir/{x}/merkez-kapat", "yoklama.devir.islem"), ("POST", "/yoklama/devir/{x}/gorundu", "yoklama.devir.islem"),
    ("*", "/yoklama/{x}", None), ("*", "/yoklama/{x}/{y}", None), ("*", "/yoklama/{x}/{y}/{z}", None),
]


def _kalip(k: str):
    return re.compile("^" + re.sub(r"\{[a-z]+\}", "[^/]+", re.escape(k).replace(r"\{", "{").replace(r"\}", "}")) + "$")


YOLLAR = [(y, _kalip(k), k, a) for y, k, a in _Y]
for _y, _r, _k, _a in YOLLAR:
    for _p in (_a or "").split("|"):
        assert _p in ("", "*") or _p in _SOZ, f"yol {_k} sözlükte olmayan anahtar: {_p}"


def yol_anahtari(yontem: str, yol: str):
    """('anahtar|anahtar' | '*' | None, eşleşti mi). Önce tam yol (statik), ilk eşleşen kazanır — sıra önemli (statik önce)."""
    y = yol[len("/api/evvel-yeni"):] if yol.startswith("/api/evvel-yeni") else yol
    y = y.rstrip("/") or "/"
    for yt, r, _k, a in YOLLAR:
        if (yt == "*" or yt == yontem.upper()) and r.match(y):
            return a, True
    return None, False


# ───────────────────────── KAYIT ─────────────────────────
_HAZIR = False


def _hazirla(cur) -> None:
    """Çekirdeğin TEK DDL modeli (ddl_kur: çağıranın işleminde savepoint + kısa lock_timeout). Bayrak yalnız tablo BAŞKA işlemde
    kurulmuş görülünce açılır (ddl_bu_islemde — kuran işlem geri alınırsa bayrak açık kalmasın · Codex P2)."""
    global _HAZIR
    if _HAZIR:
        return
    from evvel_yeni_cekirdek import ddl_bu_islemde, ddl_kur, tablo_var
    if tablo_var(cur, "ey_yetki") and tablo_var(cur, "ey_yetki_gecmis"):
        if not ddl_bu_islemde(cur):
            _HAZIR = True
        return

    def _kur(c):
        c.execute("""CREATE TABLE IF NOT EXISTS ey_yetki (
            kullanici_id TEXT PRIMARY KEY, sahip BOOLEAN NOT NULL DEFAULT FALSE, izinler JSONB NOT NULL DEFAULT '{}'::jsonb,
            surum INTEGER NOT NULL DEFAULT 1, degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        c.execute("""CREATE TABLE IF NOT EXISTS ey_yetki_gecmis (
            id BIGSERIAL PRIMARY KEY, kullanici_id TEXT NOT NULL, sahip BOOLEAN NOT NULL, izinler JSONB NOT NULL, surum INTEGER NOT NULL,
            degistiren TEXT, zaman TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
    ddl_kur(cur, "sp_ey_yetki_ddl", _kur)




def _kisi_oku(kid: str) -> dict:
    """{hepsi, sahip, izinler, kayit, aktif, hata}. Okunamazsa hata=True (erişim AÇMAZ)."""
    # Codex L6 2. tur: önbellek YOK — aktiflik / izin değişikliği bir sonraki istekte geçerli
    try:
        with db() as (_c, cur):
            _hazirla(cur)
            cur.execute("SELECT aktif FROM kullanici WHERE id=%s", (kid,))
            k = cur.fetchone()
            cur.execute("SELECT sahip, izinler FROM ey_yetki WHERE kullanici_id=%s", (kid,))
            r = cur.fetchone()
        aktif = bool(k and dict(k).get("aktif"))
        if r:
            r = dict(r)
            iz = r["izinler"] if isinstance(r["izinler"], dict) else json.loads(r["izinler"] or "{}")
            s = {"hepsi": bool(r["sahip"]) and aktif, "sahip": bool(r["sahip"]) and aktif, "izinler": _gecerli(iz) if aktif else {},
                 "kayit": True, "aktif": aktif, "hata": False}
        else:
            s = {"hepsi": False, "sahip": False, "izinler": {}, "kayit": False, "aktif": aktif, "hata": False}
    except Exception:  # noqa: BLE001
        log.warning("yetki: kişi izni okunamadı", exc_info=True)
        s = {"hepsi": False, "sahip": False, "izinler": {}, "kayit": False, "aktif": False, "hata": True}
    return s


def _gecerli(iz: dict) -> dict:
    """Sözlükte olmayan anahtar düşer · ekran yalnız 'gor', işlem yalnız 'yap' · işlem bağlı ekranı görmüyorsa düşer (Codex)."""
    out = {}
    for a, d in (iz or {}).items():
        x = _SOZ.get(a)
        if not x or d != ("gor" if x["tur"] == "ekran" else "yap"):
            continue
        out[a] = d
    return {a: d for a, d in out.items() if not _SOZ[a]["bagli"] or out.get(_SOZ[a]["bagli"]) == "gor"}


def jeton_kisi(jeton: Optional[str]) -> Optional[dict]:
    """PUBLIC — None: oturum geçersiz. Ortak yönetim girişi (kimliksiz jeton) → hepsi (sahibin acil kapısı · Opus)."""
    try:
        from admin_oturum import jeton_coz
        gecerli, _, kid = jeton_coz(jeton or "")
    except Exception:  # noqa: BLE001
        return None
    if not gecerli:
        return None
    if not kid:
        return {"kid": None, "hepsi": True, "sahip": True, "izinler": {}, "kayit": True, "aktif": True, "hata": False, "ortak": True}
    return {"kid": kid, "ortak": False, **_kisi_oku(kid)}


def var_mi(kisi: Optional[dict], anahtar_ifade: Optional[str]) -> bool:
    """'a|b' ifadesinden biri izinli mi. '*' oturumlu herkes. Modülü kapalı basamak sayılmaz."""
    if not kisi:
        return False
    if anahtar_ifade == "*" or kisi.get("hepsi"):
        return True
    iz = kisi.get("izinler") or {}
    return any(iz.get(a) in ("gor", "yap") for a in (anahtar_ifade or "").split("|") if a)


def kip() -> str:
    """ey_ayar 'yetki_kapi'. Okuma HATASI istisna olarak çıkar (çağıran son bilineni korur)."""
    from evvel_yeni_cekirdek import ayar_oku
    with db() as (_c, cur):
        v = (ayar_oku(cur, "yetki_kapi", "gozlem") or "gozlem").strip().lower()
    return v if v in ("gozlem", "zorla") else "zorla"   # bilinmeyen değer erişim açmaz


_KIP_ONB = {"v": None, "t": 0.0}


def kip_onbellekli() -> str:
    """Codex P1: okunamazsa son BAŞARILI kip korunur; hiç okunamadıysa 'zorla' (erişim açmaz); hata önbelleğe yazılmaz."""
    if time.monotonic() - _KIP_ONB["t"] > 10 or _KIP_ONB["v"] is None:
        try:
            _KIP_ONB.update(v=kip(), t=time.monotonic())
        except Exception:  # noqa: BLE001
            log.warning("yetki: kip okunamadı — son bilinen kullanılıyor", exc_info=True)
            return _KIP_ONB["v"] or "zorla"
    return _KIP_ONB["v"]


# Gözlem sayacı (bellekte): (kid, yöntem, kalıp, anahtar) → {sayi, son}
GOZLEM: Dict[tuple, dict] = {}
_GOZ_KILIT = threading.Lock()


def _gozlem(kid, yontem, kalip, anahtar):
    with _GOZ_KILIT:
        k = (kid or "-", yontem, kalip, anahtar or "eşlenmemiş")
        v = GOZLEM.setdefault(k, {"sayi": 0, "son": None})
        v["sayi"] += 1
        v["son"] = time.strftime("%Y-%m-%d %H:%M:%S")


def istek_karari(yontem: str, yol: str, jeton: Optional[str]):
    """PUBLIC — orta katman çağırır (thread havuzunda). Dönüş None = geç; (403, mesaj) = engelle.
    Yalnız GEÇERLİ merkez jetonu olan istek değerlendirilir (oturumsuz isteği kimlik kapısı ve uçların kendi kapısı yönetir)."""
    if yontem.upper() == "OPTIONS" or not jeton:
        return None
    kisi = jeton_kisi(jeton)
    if not kisi or kisi.get("hepsi"):
        return None
    anahtar, eslesti = yol_anahtari(yontem, yol)
    if eslesti and anahtar is None:
        return None   # kapı dışı (cihaz)
    if eslesti and kisi.get("aktif") and not kisi.get("hata") and var_mi(kisi, anahtar):   # Codex: pasif hesap izin kullanamaz
        return None
    kalip = next((k for yt, r, k, _a in YOLLAR if (yt == "*" or yt == yontem.upper()) and r.match(yol[len("/api/evvel-yeni"):].rstrip("/") or "/")), yol)
    _gozlem(kisi.get("kid"), yontem.upper(), kalip, anahtar if eslesti else None)
    if kip_onbellekli() != "zorla":
        return None
    if kisi.get("hata"):
        return 503, "İzinler şu an okunamadı — biraz sonra yeniden dene"
    if not kisi.get("aktif"):
        return 403, "Bu hesap kapalı"
    ad = " / ".join(_SOZ[a]["ad"] for a in (anahtar or "").split("|") if a in _SOZ) if eslesti else "bu ekran"
    return 403, f"Bu işlem için iznin yok ({ad}) — merkeze sor"


def budama_haritasi(jeton: Optional[str]) -> Optional[dict]:
    """PUBLIC — ortak okuma uçları (/kasa/durum, /tanim/liste) içeriği budamak için: None = budama yok (hepsi / gözlem kipi),
    yoksa kişinin izin haritası. GÖZLEM kipinde budanmaz (davranış değişmez; sayaç yeter)."""
    kisi = jeton_kisi(jeton)
    if not kisi or kisi.get("hepsi") or kip_onbellekli() != "zorla":
        return None
    return dict(kisi.get("izinler") or {})


# ───────────────────────── UÇLAR ─────────────────────────
router = APIRouter(prefix="/api/evvel-yeni/yetki", tags=["evvel-yeni-yetki"])


def _sahip_kapisi(jeton: Optional[str]) -> dict:
    kisi = jeton_kisi(jeton)
    if not kisi:
        raise HTTPException(401, "Merkez oturumu gerekli")
    if not (kisi.get("ortak") or (kisi.get("sahip") and kisi.get("aktif") and not kisi.get("hata"))):
        raise HTTPException(403, "Yalnız sahip değiştirebilir")
    return kisi


def _acik_modul(mod: str) -> bool:
    if mod in ("genel", "cekirdek"):
        return True
    from evvel_yeni_moduller import acik
    return acik(mod)


@router.get("/ben")
def ben(x_evvel_oturum: Optional[str] = Header(default=None)):
    """Ön yüz (menü, sekme, düğme, /cep kartları) TEK kaynaktan süzer. hepsi=True → süzme yok."""
    kisi = jeton_kisi(x_evvel_oturum)
    if not kisi:
        raise HTTPException(401, "Merkez oturumu gerekli")
    k = kip_onbellekli()
    hepsi = bool(kisi.get("hepsi")) or k != "zorla"   # gözlem: davranış AYNI (Codex P1) — okuma hatası da ekranı kapatmaz
    sayfa = {}
    for x in SOZLUK:
        for s in x["sayfa"]:
            sayfa.setdefault(s, []).append(x["anahtar"])
    return {"hepsi": hepsi, "kip": k, "sahip": bool(kisi.get("sahip")), "ortak": bool(kisi.get("ortak")),
            "izinler": {} if hepsi else kisi.get("izinler") or {}, "sayfa_anahtar": sayfa,
            "gozlem_izinler": None if kisi.get("hepsi") else kisi.get("izinler") or {},   # gözlem kipinde "zorla olsa ne görürdü" önizlemesi
            "hata": bool(kisi.get("hata"))}


@router.get("/sozluk")
def sozluk(x_evvel_oturum: Optional[str] = Header(default=None)):
    _sahip_kapisi(x_evvel_oturum)
    return {"basamaklar": [x | {"modul_acik": _acik_modul(x["mod"])} for x in SOZLUK]}


@router.get("/kullanicilar")
def kullanicilar(x_evvel_oturum: Optional[str] = Header(default=None)):
    """Sahip: aktif kimlikli hesaplar + izin kaydı durumu. Zorla'ya geçiş şartı buradan okunur."""
    _sahip_kapisi(x_evvel_oturum)
    with db() as (_c, cur):
        _hazirla(cur)
        cur.execute("""SELECT k.id, k.ad, k.kullanici_adi, k.rol, k.aktif, y.sahip, y.izinler, y.surum, y.degistiren, y.zaman
                         FROM kullanici k LEFT JOIN ey_yetki y ON y.kullanici_id = k.id ORDER BY k.aktif DESC, k.ad""")
        rows = [dict(r) for r in cur.fetchall() or []]
    out = []
    for r in rows:
        iz = r["izinler"] if isinstance(r["izinler"], dict) else json.loads(r["izinler"] or "{}") if r["izinler"] else {}
        out.append({"id": r["id"], "ad": r["ad"], "kullanici_adi": r["kullanici_adi"], "rol": r["rol"], "aktif": bool(r["aktif"]),
                    "kayit": r["surum"] is not None, "sahip": bool(r["sahip"]), "izinler": _gecerli(iz) if r["surum"] is not None else {},
                    "surum": r["surum"], "degistiren": r["degistiren"], "zaman": r["zaman"].isoformat() if r["zaman"] else None})
    eslenmemis = [x["ad"] for x in out if x["aktif"] and not x["kayit"]]
    return {"kullanicilar": out, "eslenmemis": eslenmemis, "sahip_sayisi": sum(1 for x in out if x["aktif"] and x["sahip"]),
            "kip": kip_onbellekli()}


class KisiBody(BaseModel):
    sahip: bool = False
    izinler: Dict[str, str] = {}
    surum: Optional[int] = None    # iyimser kilit: ekranda görülen sürüm (yeni kayıtta boş)


@router.post("/kisi/{kid}")
def kisi_yaz(kid: str, b: KisiBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """Sahip bir hesabın izinlerini yazar (tam set). Bilinmeyen anahtar REDDEDİLİR (Codex); geçmiş tutulur; sürüm uyuşmazsa 409."""
    from evvel_yeni_cekirdek import aktor
    _sahip_kapisi(x_evvel_oturum)
    bilinmeyen = [a for a in b.izinler if a not in _SOZ]
    if bilinmeyen:
        raise HTTPException(400, "Bilinmeyen basamak: " + ", ".join(bilinmeyen[:5]))
    yanlis = [a for a, d in b.izinler.items() if d not in ("gor", "yap", "kapali") or (d != "kapali" and d != ("gor" if _SOZ[a]["tur"] == "ekran" else "yap"))]
    if yanlis:
        raise HTTPException(400, "Ekran yalnız 'gör', işlem yalnız 'yap' alır: " + ", ".join(yanlis[:5]))
    iz = _gecerli({a: d for a, d in b.izinler.items() if d != "kapali"})
    with db() as (_c, cur):
        _hazirla(cur)
        cur.execute("SELECT pg_advisory_xact_lock(7012121)")   # Codex: iki sahip aynı anda düşürülürse sıfır sahip kalmasın
        kim = aktor(cur, x_evvel_oturum)
        cur.execute("SELECT id FROM kullanici WHERE id=%s", (kid,))
        if not cur.fetchone():
            raise HTTPException(404, "Kullanıcı yok")
        cur.execute("SELECT surum FROM ey_yetki WHERE kullanici_id=%s FOR UPDATE", (kid,))
        r = cur.fetchone()
        eski = dict(r)["surum"] if r else None
        if eski is not None and b.surum != eski:
            raise HTTPException(409, "Bu hesabın izinleri başka yerde değişti — sayfayı yenile")
        if not b.sahip:   # Codex: son AKTİF sahip düşürülemez (zorla'da kimse yönetemez olmasın; ortak şifre yine açık)
            cur.execute("""SELECT COUNT(*) AS n FROM ey_yetki y JOIN kullanici k ON k.id = y.kullanici_id
                            WHERE y.sahip AND k.aktif AND y.kullanici_id <> %s""", (kid,))
            diger = int(dict(cur.fetchone())["n"])
            cur.execute("SELECT sahip FROM ey_yetki WHERE kullanici_id=%s", (kid,))
            simdi_sahip = bool(dict(cur.fetchone() or {}).get("sahip"))
            if simdi_sahip and not diger and kip_onbellekli() == "zorla":
                raise HTTPException(409, "Son sahip kaldırılamaz — önce başka bir hesabı sahip yap")
        yeni = (eski or 0) + 1
        cur.execute("""INSERT INTO ey_yetki (kullanici_id, sahip, izinler, surum, degistiren, zaman) VALUES (%s,%s,%s::jsonb,%s,%s,NOW())
                       ON CONFLICT (kullanici_id) DO UPDATE SET sahip=EXCLUDED.sahip, izinler=EXCLUDED.izinler, surum=EXCLUDED.surum,
                       degistiren=EXCLUDED.degistiren, zaman=NOW()""", (kid, b.sahip, json.dumps(iz), yeni, kim))
        cur.execute("INSERT INTO ey_yetki_gecmis (kullanici_id, sahip, izinler, surum, degistiren) VALUES (%s,%s,%s::jsonb,%s,%s)",
                    (kid, b.sahip, json.dumps(iz), yeni, kim))
    return {"ok": True, "surum": yeni, "mesaj": ("Sahip olarak işaretlendi" if b.sahip else f"{len(iz)} basamak açık") + " — kaydedildi"}


class KipBody(BaseModel):
    kip: str


@router.post("/kip")
def kip_yaz(b: KipBody, x_evvel_oturum: Optional[str] = Header(default=None)):
    """gozlem ↔ zorla. Zorla şartı (Opus): eşlenmemiş aktif kimlikli hesap 0 + en az 1 sahip kaydı."""
    from evvel_yeni_cekirdek import aktor, ayar_yaz
    cagiran = _sahip_kapisi(x_evvel_oturum)
    if b.kip not in ("gozlem", "zorla"):
        raise HTTPException(400, "Kip 'gozlem' ya da 'zorla' olmalı")
    if b.kip == "zorla":
        d = kullanicilar(x_evvel_oturum)
        if d["eslenmemis"]:
            raise HTTPException(409, "Önce şu hesapların izinlerini yaz: " + ", ".join(d["eslenmemis"][:6]))
        if not d["sahip_sayisi"] and not cagiran.get("ortak"):   # canlıda sahip ORTAK şifreyle girer (kişisel hesabı yok): bu çağrı acil
            raise HTTPException(409, "En az bir hesap 'sahip' olarak işaretlenmeli")   # kapının çalıştığının kanıtı (30 Eki, Opus şartının uyarlaması)
    with db() as (_c, cur):
        ayar_yaz(cur, "yetki_kapi", b.kip, aktor(cur, x_evvel_oturum))
    _KIP_ONB.update(v=b.kip, t=time.monotonic())
    return {"ok": True, "kip": b.kip, "mesaj": "İzinler artık UYGULANIYOR" if b.kip == "zorla" else "Gözlem: kimse engellenmez, yalnız sayılır"}


@router.get("/gozlem")
def gozlem(x_evvel_oturum: Optional[str] = Header(default=None)):
    """Gözlem sayacı: zorla kipinde engellenecek istekler (kişi · uç · anahtar). Sunucu yeniden başlarsa sıfırlanır."""
    _sahip_kapisi(x_evvel_oturum)
    with _GOZ_KILIT:
        satir = [{"kid": k[0], "yontem": k[1], "yol": k[2], "anahtar": k[3], **v} for k, v in GOZLEM.items()]
    satir.sort(key=lambda x: -x["sayi"])
    return {"kip": kip_onbellekli(), "satirlar": satir[:300]}
