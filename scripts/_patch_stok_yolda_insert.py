"""Patch operasyon_stok_motor: safe stok_yolda INSERT + iptal SELECT fallback."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
p = ROOT / "operasyon_stok_motor.py"
text = p.read_text(encoding="utf-8")

old_insert = """        # stok_yolda kaydı
        yid = str(uuid.uuid4())
        try:
            cur.execute(
                \"\"\"
                INSERT INTO stok_yolda
                    (id, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, durum,
                     sevk_kaynak_depo_sube_id)
                VALUES (%s, %s, %s, %s, %s, %s, 'yolda', %s)
                \"\"\",
                (yid, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, kaynak_depo),
            )
        except Exception as exc:
            if "sevk_kaynak_depo_sube_id" not in str(exc).lower():
                raise
            ensure_stok_yolda_columns(cur)
            cur.execute(
                \"\"\"
                INSERT INTO stok_yolda
                    (id, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, durum,
                     sevk_kaynak_depo_sube_id)
                VALUES (%s, %s, %s, %s, %s, %s, 'yolda', %s)
                \"\"\",
                (yid, siparis_talep_id, sube_id, kalem_kodu, kalem_adi, sevk_adet, kaynak_depo),
            )
        yolda_ids.append(yid)"""

new_insert = """        # stok_yolda kaydı
        yid = str(uuid.uuid4())
        from database import stok_yolda_insert_row

        stok_yolda_insert_row(
            cur,
            yid=yid,
            siparis_talep_id=siparis_talep_id,
            sube_id=sube_id,
            kalem_kodu=kalem_kodu,
            kalem_adi=kalem_adi,
            sevk_adet=sevk_adet,
            kaynak_depo=kaynak_depo,
        )
        yolda_ids.append(yid)"""

if old_insert not in text:
    raise SystemExit("stok_yolda INSERT block not found")
text = text.replace(old_insert, new_insert, 1)

old_sevk_import = """    from database import ensure_stok_yolda_columns

    ensure_stok_yolda_columns(cur)
    cur.execute(
        \"\"\"
        SELECT sube_id,
               COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS kaynak_depo_sube_id,
               durum
        FROM siparis_talep WHERE id=%s"""

new_sevk_import = """    cur.execute(
        \"\"\"
        SELECT sube_id,
               COALESCE(hedef_depo_sube_id, sevkiyat_sube_id) AS kaynak_depo_sube_id,
               durum
        FROM siparis_talep WHERE id=%s"""

if old_sevk_import not in text:
    raise SystemExit("sevk_cikti ensure block not found")
text = text.replace(old_sevk_import, new_sevk_import, 1)

old_iptal_select = """    cur.execute(
        \"\"\"
        SELECT id, kalem_kodu, kalem_adi, sevk_adet,
               COALESCE(sevk_kaynak_depo_sube_id, %s) AS kaynak_depo_sube_id
        FROM stok_yolda
        WHERE siparis_talep_id=%s AND durum='yolda'
        \"\"\",
        (str(rd.get("kaynak_depo_sube_id") or "").strip() or None, aid),
    )
    yolda_rows = [dict(r) for r in (cur.fetchall() or [])]"""

new_iptal_select = """    fb_kaynak = str(rd.get("kaynak_depo_sube_id") or "").strip() or None
    from database import stok_yolda_sevk_kaynak_col_exists

    if stok_yolda_sevk_kaynak_col_exists(cur):
        cur.execute(
            \"\"\"
            SELECT id, kalem_kodu, kalem_adi, sevk_adet,
                   COALESCE(sevk_kaynak_depo_sube_id, %s) AS kaynak_depo_sube_id
            FROM stok_yolda
            WHERE siparis_talep_id=%s AND durum='yolda'
            \"\"\",
            (fb_kaynak, aid),
        )
    else:
        cur.execute(
            \"\"\"
            SELECT id, kalem_kodu, kalem_adi, sevk_adet, %s AS kaynak_depo_sube_id
            FROM stok_yolda
            WHERE siparis_talep_id=%s AND durum='yolda'
            \"\"\",
            (fb_kaynak, aid),
        )
    yolda_rows = [dict(r) for r in (cur.fetchall() or [])]"""

if old_iptal_select not in text:
    raise SystemExit("iptal SELECT block not found")
text = text.replace(old_iptal_select, new_iptal_select, 1)

p.write_text(text, encoding="utf-8")
print("patched operasyon_stok_motor.py OK")
