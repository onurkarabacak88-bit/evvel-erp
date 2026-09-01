# FABLE — HALKA 1-2 (talep doğuşu → merkez yönlendirme)

### H12-01 | P0 | 'gonderildi' talep geriye çekilip İKİNCİ KEZ sevk edilebiliyor
operasyon_merkez_api.py:9897, 10040-10041, 10111-10126
sevkiyata-gonder durum kapısı ('bekliyor','hazirlaniyor','gonderildi') — mal fiilen yolda iken yeniden yönlendirme serbest.
kalem_durumlari SIFIRDAN kurulup her kaleme gonderilen_adet:0 yazılıyor; çift-kanal freni yalnız toptanci_siparis'e bakıyor, stok_yolda'ya HİÇ bakmıyor.
SENARYO: Zafer→Gazze deposu yola çıktı (stok_yolda 5×Süt 'yolda'). Operatör aynı talebi Köyceğiz deposuna yollar → kapı geçer → Süt gonderilen_adet=0 → Köyceğiz 5 Süt daha çıkarır → şube 10 alır, kayıt 5 der.
ÖNERİ: 'gonderildi' durumunda / 'yolda' stok_yolda satırı varken 409; önce akisi-iptal istensin.

### H12-02 | P0 | SAVEPOINT'siz yutulan yazım → "success:true" ama HİÇBİR ŞEY kaydedilmedi
sube_panel.py:5790-5795 (/siparis-onay), 5890-5894 (/siparis-yoklama), 5664-5669 (/siparis-kalem-ekle), operasyon_merkez_api.py:10156-10177 (/siparis/sevkiyata-gonder)
siparis_olustu_kaydet çıplak except ile yutuluyor, database.savepoint() (database.py:75) KULLANILMIYOR. Patlayan cur.execute transaction'ı abort eder; db() çıkışında conn.commit() (database.py:147) abort'ta ROLLBACK'e döner, psycopg2 hata fırlatmaz. Uç success:true + talep_id döner, sipariş yazılmamıştır.
ÖNERİ: dört yutma bloğunu with savepoint(cur, ...) içine al.

### H12-03 | P1 | /siparis-yoklama kasa+şube açılış kapılarını TÜMÜYLE atlıyor
sube_panel.py:5815-5852 — yalnız gorev_yoklama kaydına bakıyor; _bugun_kasa_acildi_mi / _bugun_sube_acildi_mi yok (krş. 5713-5716).

### H12-04 | P1 | _kalem_merge: id/ad karışımı + Türkçe 'İ'.lower() → aynı ürün İKİ SATIR
sube_panel.py:5503-5527 (5510-5511, 5519). Anahtar urun_id or urun_ad.lower(); id'li ve id'siz kalem hiç kesişmez. 'İ'.lower() = 'i'+U+0307.
Ops tarafı ad_anahtar ile kapatmıştı (operasyon_merkez_api.py:9988-9995); şube merge'ü hâlâ çıplak .lower().

### H12-05 | P1 | kalem-ekle kalem_surum ARTIRMIYOR → bayat pencere kilidi delinir, eklenen kalem sessizce depo dışı kalır
sube_panel.py:5600-5616 vs operasyon_merkez_api.py:9888-9896, 10017-10024, 10122.
Eklenen kalem operatörün eski seçiminde yok → 'depoya_yonlendirilmedi' damgalanır, atlanan.secilmedi içinde kaybolur.

### H12-06 | P1 | Depo "eksik kalan" listesi toptancıya giden / iptal kalemleri de "kalan" sayıyor
sube_panel.py:4632-4695 (4664-4684). kalan = istenen − gonderilen, DURUMA bakmıyor.
toptanciya_gitti / merkez_iptal / depoya_yonlendirilmedi satırları depo panelinde dirilir → aynı mal iki kanaldan gelebilir.

### H12-07 | P2 | 409 ile sessiz merge çelişkisi + merge hedefinde TARİH FİLTRESİ YOK
sube_panel.py:5479-5500, 5530-5543, 5747-5757; 4952-4967.
_siparis_bekliyor_yonlendirilmemis tarih filtresiz ORDER BY olusturma DESC LIMIT 1 → günler önceki unutulmuş talebe eklenir; bekleyen-liste tarih=CURRENT_DATE olduğu için şube kalemlerini GÖREMEZ.

### H12-08 | P2 | İptal işaretli kalem şube özetinde hâlâ "istenmiş" görünüyor + merge yolu davranış denetimini atlıyor
sube_panel.py:4541-4561, 4979-4990, 5585-5637. _siparis_kalem_ozet_from_json iptal bayrağına bakmıyor; merge dalı siparis_olustu_kaydet çağırmıyor.

### ZİNCİR HÜKMÜ
Adet tek gerçek yerine DÖRT deftere yazılıyor: kalemler (şubenin niyeti) · kalem_durumlari (merkezin kararı) · stok_yolda (fiilî mal) · operasyon_defter (tarihçe) — hizalayan tek mekanizma yok.
Doğumda kayıp: yutulan siparis_olustu_kaydet INSERT'i ROLLBACK'e götürür. Düşüşte kayıp: gonderildi talebin yeniden yönlendirilmesi aynı malı ikinci kez yola çıkarır. Kenarda kayıp: merge id/ad çatlağı ve artmayan kalem_surum kalemi "seçilmedi" çukuruna düşürür.
