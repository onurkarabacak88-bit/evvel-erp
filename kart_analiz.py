"""
kart_analiz.py — PDF kredi kartı ekstresi parser + analiz API
Desteklenen bankalar: Enpara, Garanti BBVA, Yapı Kredi, Ziraat
"""
from __future__ import annotations
import re, io, json, uuid
from typing import List, Dict, Any, Optional, Tuple
from datetime import date, datetime
import pdfplumber
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter(prefix="/kart-analiz", tags=["kart-analiz"])

# ─── Türkçe ay adları ────────────────────────────────────────────────────────
_AY = {
    "ocak":1,"şubat":2,"subat":2,"mart":3,"nisan":4,"mayıs":5,"mayis":5,
    "haziran":6,"temmuz":7,"ağustos":8,"agustos":8,"eylül":9,"eylul":9,
    "ekim":10,"kasım":11,"kasim":11,"aralık":12,"aralik":12,
}

def _parse_tarih_dmy(s: str) -> Optional[str]:
    m = re.match(r'(\d{1,2})[/.](\d{2})[/.](\d{4})', s.strip())
    if m: return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None

def _parse_tarih_tr(s: str) -> Optional[str]:
    m = re.match(r'(\d{1,2})\s+(\w+)\s+(\d{4})', s.strip())
    if m:
        ay = _AY.get(m.group(2).lower())
        if ay: return f"{m.group(3)}-{ay:02d}-{int(m.group(1)):02d}"
    return None

def _parse_tutar(s: str) -> Tuple[float, bool]:
    """'1.234,56 TL' → (1234.56, False)  //  '12.000,00 TL+' / '+12.000,00' → (12000.0, True)"""
    s = s.strip()
    is_pay = s.endswith('+') or s.startswith('+')
    clean = re.sub(r'[TLtl\s+]', '', s).lstrip('-').replace('.', '').replace(',', '.')
    try:    return float(clean), is_pay
    except: return 0.0, is_pay

# ─── Kategori zenginleştirme ──────────────────────────────────────────────────
PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r'spotify|netflix|youtube|disney\+|blutv|gain\.tv|mubi|apple\s*tv|exxen|tod\b', re.I), 'Streaming'),
    (re.compile(r'migros|bim[\s\-]|bim\s*[a-z0-9]|a101|şok[\s\-]|carrefour|metro\s*gross|hakmar|çilek\s*market|onur\s*market', re.I), 'Market'),
    (re.compile(r'getir|yemeksepeti|trendyol\s*go|mcdonalds|burger\s*king|popeyes|kfc|domino|pizza|lahmacun|kebap|köfte|döner|fast\s*food|lokanta|restoran|restaurant|cafe\s*&|damaga|sofioğlu|napoles|pasaport\s*pizeria', re.I), 'Yemek & Restoran'),
    (re.compile(r'starbucks|caribou|gloria|coffee|kahve\s*dünya|evvel|tcoffee', re.I), 'Kahve'),
    (re.compile(r'trendyol\.com|hepsiburada|hepsipay|n11|amazon|iyzico.*amazon|gittigidi|çiçeksepeti', re.I), 'Online Alışveriş'),
    (re.compile(r'zara|mango|h&m|lcw|lc\s*waikiki|defacto|koton|boyner|bershka|stradivarius|özdilek|sarar|giyim|tekstil', re.I), 'Giyim'),
    (re.compile(r'opet|shell\b|bp\b|total[\s\-]|lukoil|aytemiz|powersarj|zes[\s\-]digital|otojet\s*enerji|akaryak', re.I), 'Yakıt & EV Şarj'),
    (re.compile(r'paycell.*trugo|trugo|t\.r\.u\.g\.o|param.*powersarj', re.I), 'Araç Şarj'),
    (re.compile(r'pegasus|thy|turkish\s*air|sunexpress|anadolujet|rosa\s*turizm|otel|hotel|booking|airbnb', re.I), 'Seyahat'),
    (re.compile(r'uber|bitaksi|hgs\s*talimat|ogs\b|toplu\s*taş|iett|konya\s*bld.*taş|ulaşım|otopark', re.I), 'Ulaşım'),
    (re.compile(r'mepaş|konya\s*su|enerjisa|enerya.*gaz|konya.*gaz|başkent\s*gaz|igdaş|iski|elektrik\s*fatura|doğalgaz', re.I), 'Faturalar'),
    (re.compile(r'turkcell|vodafone|türk\s*telekom|ttnet|millenicom|netgsm|superonline|trkcll', re.I), 'Telefon & İnternet'),
    (re.compile(r'eczane|medikal|hastane|klinik|doktor|dişçi|diş\s*hek|eczaci|pharmacy|lab\b', re.I), 'Sağlık'),
    (re.compile(r'okul|kolej|üniversite|kurs|etüt|dershane|eğitim|akademi|gündoğdu|ahen\s*müh', re.I), 'Eğitim'),
    (re.compile(r'sigorta|axa\b|allianz|mapfre|zurich|generali|ana\s*sigorta', re.I), 'Sigorta'),
    (re.compile(r'sgk|s/sgk|vergi\s*da|v\.d\.|mevlana\s*v\.d|kocaeli\s*v\.d|g\.i\.b', re.I), 'Vergi & SGK'),
    (re.compile(r'ikea|kaya\s*home|yataş|istikbal|bellona|tab\s*mobilya|ev\s*tekstil|hırdavat|boya\s*nal|nalb|inşaat', re.I), 'Ev & Dekorasyon'),
    (re.compile(r'mng\s*kargo|yurtiçi|aras\s*kargo|ptt\s*kargo|sürat\s*kargo|kargo', re.I), 'Kargo'),
    (re.compile(r'okubee|çocuk\s*giyim|toyzz|oyuncak|bebek', re.I), 'Çocuk'),
    (re.compile(r'paraşüt|param\b|papara|fast\s*ödeme|p2p|transfer', re.I), 'Transfer'),
    (re.compile(r'fatura.*ücret|işlem.*ücret|bsmv|kkdf|dönem\s*faiz|alışveriş\s*faiz|nakit\s*avans\s*faiz', re.I), 'Banka Ücret & Faiz'),
    (re.compile(r'kırtasiye|saray\s*kırt|paper|kalem\s*defteri|büro\s*malz', re.I), 'Kırtasiye & Ofis'),
    (re.compile(r'eğlence|sinema|bowling|konser|tiyatro|gösteri', re.I), 'Eğlence'),
]

def _enrich(aciklama: str, banka_kat: str = '') -> str:
    if banka_kat and banka_kat.strip().lower() not in ('', 'diğer', 'diger', 'other', 'diğer harcamalar', 'diğerleri'):
        return banka_kat.strip()
    for pat, kat in PATTERNS:
        if pat.search(aciklama):
            return kat
    return 'Diğer'

# ─── Banka tespiti ────────────────────────────────────────────────────────────
def _detect_bank(text: str) -> str:
    t = text[:800].lower()
    if 'enpara' in t:                  return 'Enpara'
    if 'garanti' in t or 'bonus' in t: return 'Garanti BBVA'
    if 'yapı kredi' in t or 'yapi kredi' in t or 'worldpuan' in t: return 'Yapı Kredi'
    if 'bankkart' in t or 'ziraat' in t: return 'Ziraat'
    return 'Bilinmeyen'

def _extract_kart_meta(text: str) -> Tuple[str, str]:
    """(kart_no, kart_sahibi)"""
    kart_no = ''
    kart_sahibi = ''
    m = re.search(r'[Kk]art\s*[Nn]umara.*?:\s*([0-9*]{4}[\s\-][0-9*]{2}[*]{2}[\s\-\*]{0,4}[0-9*]{4})', text)
    if m: kart_no = m.group(1).strip()
    m2 = re.search(r'[Ss]ay[ıi]n\s+([A-ZÇĞİÖŞÜa-zçğışöü\s]{3,40})', text)
    if m2: kart_sahibi = m2.group(1).strip().title()
    return kart_no, kart_sahibi

# ─── ENPARA parser ────────────────────────────────────────────────────────────
_ENP_LINE = re.compile(
    r'^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(-\s*[\d.]+,\d{2}\s*TL|[\d.]+,\d{2}\s*TL)\s*$'
)

def _parse_enpara(pages_text: List[str], kart_no: str, kart_sahibi: str) -> List[Dict]:
    txns = []
    for text in pages_text:
        for line in text.split('\n'):
            line = line.strip()
            m = _ENP_LINE.match(line)
            if not m: continue
            tarih = _parse_tarih_dmy(m.group(1))
            if not tarih: continue
            aciklama = re.sub(r'\d+/\d+\s*$', '', m.group(2)).strip()
            aciklama = re.sub(r'\(.*?\)', '', aciklama).strip()
            aciklama = aciklama.replace('- kapanan kart', '').strip().rstrip('-').strip()
            tutar_str = m.group(3)
            is_pay = tutar_str.strip().startswith('-')
            tutar, _ = _parse_tutar(tutar_str)
            is_fee = bool(re.search(r'faiz|bsmv|kkdf|ücret', aciklama, re.I))
            txns.append({
                'tarih': tarih, 'aciklama': aciklama, 'tutar': tutar,
                'banka': 'Enpara', 'kart_no': kart_no, 'kart_sahibi': kart_sahibi,
                'odeme_mi': is_pay and not is_fee,
                'kategori': _enrich(aciklama),
            })
    return txns

# ─── GARanti BBVA parser ──────────────────────────────────────────────────────
_GAR_DATE = re.compile(r'^(\d{1,2}\s+\w+\s+\d{4})\s+(.+)$')
_AYLAR_TR_LIST = list(_AY.keys())

def _is_tr_month(word: str) -> bool:
    return word.lower() in _AY

def _parse_garanti(pages_text: List[str], kart_no: str, kart_sahibi: str) -> List[Dict]:
    txns = []
    current_kat = ''
    # Garanti embeds category names as section headers
    KAT_HEADERS = {
        'akaryakıt': 'Yakıt & EV Şarj', 'akaryak': 'Yakıt & EV Şarj',
        'cafe & restaurant': 'Yemek & Restoran', 'restoran': 'Yemek & Restoran',
        'süpermarket': 'Market', 'supermarket': 'Market', 'fast food': 'Yemek & Restoran',
        'pastane': 'Yemek & Restoran', 'eğlence': 'Eğlence', 'eğitim': 'Eğitim',
        'seyahat': 'Seyahat', 'ev bakım & onarım': 'Ev & Dekorasyon',
        'ev dekorasyon': 'Ev & Dekorasyon', 'diğer harcamalar': '',
        'giyim & aksesuar': 'Giyim', 'spor': 'Spor', 'teknoloji': 'Elektronik',
    }
    for text in pages_text:
        for line in text.split('\n'):
            line = line.strip()
            if not line or line.lower().startswith('bonus') or 'teşekkür' in line.lower() and len(line) < 60:
                # Payment line
                if 'teşekkür' in line.lower():
                    m_pay = re.search(r'([\d.]+,\d{2})\+', line)
                    m_date = re.match(r'^(\d{1,2}\s+\w+\s+\d{4})', line)
                    if m_pay and m_date:
                        tarih = _parse_tarih_tr(m_date.group(1))
                        if tarih:
                            tutar, _ = _parse_tutar(m_pay.group(1))
                            txns.append({
                                'tarih': tarih, 'aciklama': 'Kart ödemesi',
                                'tutar': tutar, 'banka': 'Garanti BBVA',
                                'kart_no': kart_no, 'kart_sahibi': kart_sahibi,
                                'odeme_mi': True, 'kategori': 'Ödeme',
                            })
                continue

            # Category header detection
            ll = line.lower()
            for hdr, kat in KAT_HEADERS.items():
                if ll == hdr or ll.startswith(hdr + '\n'):
                    current_kat = kat
                    break

            # Transaction line: starts with date
            parts = line.split()
            if len(parts) >= 3 and parts[0].isdigit() and _is_tr_month(parts[1] if len(parts) > 1 else ''):
                tarih = _parse_tarih_tr(' '.join(parts[:3]))
                if not tarih: continue
                rest = ' '.join(parts[3:])
                # Payment?
                is_pay = rest.strip().endswith('+')
                # Amount: last token
                tokens = rest.split()
                if not tokens: continue
                amt_str = tokens[-1].rstrip('+')
                if not re.match(r'^[\d.,]+$', amt_str): continue
                tutar, _ = _parse_tutar(amt_str)
                if tutar <= 0: continue
                # Description: remove taksit & bonus columns
                desc_parts = tokens[:-1]  # drop amount
                # Remove bonus (single float) if present before amount
                if desc_parts and re.match(r'^[\d.,]+$', desc_parts[-1]):
                    desc_parts = desc_parts[:-1]
                # Remove taksit info "X.Taksit"
                desc_parts = [p for p in desc_parts if not re.match(r'^\d+\.Taksit$', p, re.I)]
                # Remove taksit calc "Ax6=B"
                desc_parts = [p for p in desc_parts if not re.match(r'[\d.,]+x\d+=[\d.,]+', p)]
                aciklama = ' '.join(desc_parts).strip()
                is_fee = bool(re.search(r'faiz|bsmv|kkdf|ücret|dönem', aciklama, re.I))
                txns.append({
                    'tarih': tarih, 'aciklama': aciklama, 'tutar': tutar,
                    'banka': 'Garanti BBVA', 'kart_no': kart_no, 'kart_sahibi': kart_sahibi,
                    'odeme_mi': is_pay and not is_fee,
                    'kategori': _enrich(aciklama, current_kat if not is_pay else 'Ödeme'),
                })
    return txns

# ─── YAPI KREDİ parser ───────────────────────────────────────────────────────
def _parse_yapikrdi(pages_text: List[str], kart_no: str, kart_sahibi: str) -> List[Dict]:
    txns = []
    skip_next = False
    for text in pages_text:
        lines = text.split('\n')
        for i, line in enumerate(lines):
            line = line.strip()
            if skip_next:
                skip_next = False
                continue
            if not line: continue
            parts = line.split()
            if len(parts) < 3: continue
            # Date starts with digit + Turkish month
            if not (parts[0].isdigit() and _is_tr_month(parts[1] if len(parts) > 1 else '')): continue
            tarih = _parse_tarih_tr(' '.join(parts[:3]))
            if not tarih: continue
            rest_parts = parts[3:]
            if not rest_parts: continue
            # Payment line: "ÖDEME-İNTERNET +99.500,00"
            is_pay = rest_parts[0].startswith('+') or (len(rest_parts) > 0 and rest_parts[-1].startswith('+'))
            # Amount: last numeric token
            amt_str = rest_parts[-1].lstrip('+')
            if re.match(r'^[\d.,]+$', amt_str):
                tutar, _ = _parse_tutar(amt_str)
            else:
                continue
            if tutar <= 0: continue
            # Description: everything except last (amount) and maybe puan (last digit token)
            desc_parts = rest_parts[:-1]
            # Remove puan (single integer at end)
            if desc_parts and re.match(r'^\d+$', desc_parts[-1]):
                desc_parts = desc_parts[:-1]
            # Remove "Kalan/Taksit" pattern "X.XXX,XX / Y"
            desc_parts = [p for p in desc_parts
                          if not re.match(r'^[\d.,]+$', p) and p != '/' and not re.match(r'^\d+$', p)]
            aciklama = ' '.join(desc_parts).strip()
            # Next line might be taksit info — skip
            if i + 1 < len(lines) and re.search(r"TL'lik i[şs]lemin", lines[i+1]):
                skip_next = True
            is_fee = bool(re.search(r'faiz|bsmv|kkdf|ücret', aciklama, re.I))
            txns.append({
                'tarih': tarih, 'aciklama': aciklama, 'tutar': tutar,
                'banka': 'Yapı Kredi', 'kart_no': kart_no, 'kart_sahibi': kart_sahibi,
                'odeme_mi': is_pay and not is_fee,
                'kategori': _enrich(aciklama, 'Ödeme' if is_pay else ''),
            })
    return txns

# ─── ZİRAAT parser ───────────────────────────────────────────────────────────
_ZRT_LINE = re.compile(r'^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+([\d.]+,\d{2})\+?\s*(?:[\d.]+,\d{2}\s*){0,2}([\d.,]*)$')

def _parse_ziraat(pages_text: List[str], kart_no: str, kart_sahibi: str) -> List[Dict]:
    txns = []
    for text in pages_text:
        for line in text.split('\n'):
            line = line.strip()
            # Skip taksit sub-lines
            if re.search(r'[Tt]aksit.*[Tt]aksidi|[Tt]aksit\s+\d+\.\s+[Tt]aksit', line): continue
            m = re.match(r'^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+([\d.]+,\d{2})(\+)?(?:\s+[\d.,]+)*$', line)
            if not m: continue
            tarih = _parse_tarih_dmy(m.group(1))
            if not tarih: continue
            aciklama = m.group(2).strip()
            tutar_str = m.group(3)
            is_pay = bool(m.group(4))  # ends with +
            is_pay = is_pay or bool(re.search(r'[öo]deme|te[şs]ekk[üu]r', aciklama, re.I))
            tutar, _ = _parse_tutar(tutar_str)
            if tutar <= 0: continue
            # Clean description
            aciklama = re.sub(r'\b[A-Z]{2,3}\s*$', '', aciklama).strip()  # Remove city code
            is_fee = bool(re.search(r'faiz|bsmv|kkdf|[üu]cret|vergi', aciklama, re.I))
            txns.append({
                'tarih': tarih, 'aciklama': aciklama, 'tutar': tutar,
                'banka': 'Ziraat', 'kart_no': kart_no, 'kart_sahibi': kart_sahibi,
                'odeme_mi': is_pay and not is_fee,
                'kategori': _enrich(aciklama, 'Ödeme' if is_pay else ''),
            })
    return txns

# ─── Ana parser ───────────────────────────────────────────────────────────────
def parse_pdf(pdf_bytes: bytes) -> List[Dict]:
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        pages_text = [p.extract_text() or '' for p in pdf.pages]
    full_text = '\n'.join(pages_text)
    banka = _detect_bank(full_text)
    kart_no, kart_sahibi = _extract_kart_meta(full_text)
    if banka == 'Enpara':      txns = _parse_enpara(pages_text, kart_no, kart_sahibi)
    elif banka == 'Garanti BBVA': txns = _parse_garanti(pages_text, kart_no, kart_sahibi)
    elif banka == 'Yapı Kredi':   txns = _parse_yapikrdi(pages_text, kart_no, kart_sahibi)
    elif banka == 'Ziraat':       txns = _parse_ziraat(pages_text, kart_no, kart_sahibi)
    else:
        return []
    # Dedup by tarih+aciklama+tutar
    seen = set()
    unique = []
    for t in txns:
        key = (t['tarih'], t['aciklama'][:30], round(t['tutar'], 2))
        if key not in seen:
            seen.add(key)
            unique.append(t)
    return unique

# ─── Recurring tespiti ────────────────────────────────────────────────────────
def _detect_recurring(txns: List[Dict]) -> Dict[str, Any]:
    from collections import defaultdict
    by_desc: Dict[str, List] = defaultdict(list)
    for t in txns:
        if t.get('odeme_mi'): continue
        key = re.sub(r'\s+\d+$', '', t['aciklama']).strip().lower()[:40]
        by_desc[key].append(t)
    recurring = []
    for desc, items in by_desc.items():
        if len(items) < 2: continue
        tutarlar = [i['tutar'] for i in items]
        avg = sum(tutarlar) / len(tutarlar)
        variance = max(tutarlar) - min(tutarlar)
        if variance / avg > 0.3: continue  # Tutarsız miktarlar recurring değil
        # Abonelik mi yoksa sabit yükümlülük mü?
        kat = items[0]['kategori']
        is_sabit = kat in ('Faturalar', 'Sigorta', 'Vergi & SGK', 'Telefon & İnternet',
                           'Eğitim', 'Banka Ücret & Faiz')
        recurring.append({
            'aciklama': items[0]['aciklama'],
            'kategori': kat,
            'banka': items[0]['banka'],
            'aylık_ortalama': round(avg, 2),
            'işlem_sayısı': len(items),
            'tür': 'Sabit Yükümlülük' if is_sabit else 'İptal Edilebilir Abonelik',
        })
    recurring.sort(key=lambda x: -x['aylık_ortalama'])
    return recurring

# ─── API endpoint ─────────────────────────────────────────────────────────────
@router.post("/parse-pdf")
async def parse_pdf_endpoint(files: List[UploadFile] = File(...)):
    """Birden fazla PDF ekstresi yükle, işlenmiş işlem listesini döndür."""
    all_txns: List[Dict] = []
    errors = []
    for f in files:
        if not f.filename.lower().endswith('.pdf'):
            errors.append(f"{f.filename}: PDF değil, atlandı")
            continue
        try:
            data = await f.read()
            txns = parse_pdf(data)
            all_txns.extend(txns)
        except Exception as e:
            errors.append(f"{f.filename}: {e}")

    if not all_txns and errors:
        raise HTTPException(400, detail='; '.join(errors))

    # Sırala: tarih desc
    all_txns.sort(key=lambda x: x['tarih'], reverse=True)

    # Özet istatistikler
    harcamalar = [t for t in all_txns if not t.get('odeme_mi')]
    odemeler   = [t for t in all_txns if t.get('odeme_mi')]

    toplam_harcama = sum(t['tutar'] for t in harcamalar)
    toplam_odeme   = sum(t['tutar'] for t in odemeler)

    # Kategori dağılımı
    from collections import defaultdict
    kat_map: Dict[str, float] = defaultdict(float)
    for t in harcamalar:
        kat_map[t['kategori']] += t['tutar']
    kat_dagilim = sorted([{'kategori': k, 'toplam': round(v, 2)} for k, v in kat_map.items()],
                          key=lambda x: -x['toplam'])

    # Aylık harcama
    ay_map: Dict[str, float] = defaultdict(float)
    for t in harcamalar:
        ay = t['tarih'][:7]  # YYYY-MM
        ay_map[ay] += t['tutar']
    aylik = sorted([{'ay': k, 'toplam': round(v, 2)} for k, v in ay_map.items()], key=lambda x: x['ay'])

    # Kart bazlı
    kart_map: Dict[str, float] = defaultdict(float)
    for t in harcamalar:
        label = f"{t['banka']} {t.get('kart_no','')[-4:] if t.get('kart_no') else ''}".strip()
        kart_map[label] += t['tutar']
    kart_dagilim = sorted([{'kart': k, 'toplam': round(v, 2)} for k, v in kart_map.items()],
                           key=lambda x: -x['toplam'])

    recurring = _detect_recurring(all_txns)

    return {
        'islemler': all_txns,
        'ozet': {
            'toplam_islem': len(all_txns),
            'harcama_sayisi': len(harcamalar),
            'toplam_harcama': round(toplam_harcama, 2),
            'toplam_odeme': round(toplam_odeme, 2),
            'tarih_aralik': {
                'baslangic': min(t['tarih'] for t in all_txns) if all_txns else None,
                'bitis':     max(t['tarih'] for t in all_txns) if all_txns else None,
            },
        },
        'kat_dagilim': kat_dagilim,
        'aylik_harcama': aylik,
        'kart_dagilim': kart_dagilim,
        'tekrarlayan': recurring,
        'hatalar': errors,
    }

# ─── Kartlar listesi — eşleştirme için ───────────────────────────────────────
@router.get("/kartlar-listesi")
def kartlar_listesi():
    """Mevcut kart tanımlarını döndürür (ekstre eşleştirme için)."""
    from database import db
    with db() as (conn, cur):
        cur.execute("""
            SELECT k.id, k.kart_adi, k.banka, k.son_dort_hane,
                   k.limit_tutar, k.faiz_orani,
                   COALESCE(
                       (SELECT SUM(h.tutar) FROM kart_hareketleri h
                        WHERE h.kart_id = k.id AND h.durum = 'aktif'
                          AND h.islem_turu NOT IN ('ODEME','FAIZ')),
                       0
                   ) AS guncel_borc
            FROM kartlar k
            WHERE k.aktif = TRUE
            ORDER BY k.banka, k.kart_adi
        """)
        return [dict(r) for r in cur.fetchall()]

# ─── Aktarım: eşleştirilmiş PDF işlemlerini kart_hareketleri'ne yaz ──────────
class AktarimKalem(BaseModel):
    tarih: str
    aciklama: str
    tutar: float
    kategori: str = ''

class AktarimBody(BaseModel):
    kart_id: str
    islemler: List[AktarimKalem]

@router.post("/aktar")
def aktar(body: AktarimBody):
    """
    Eşleştirilmiş PDF harcamalarını kart_hareketleri'ne HARCAMA olarak yazar.
    Duplike kontrolü: aynı kart + tarih + tutar + açıklama varsa atlanır.
    """
    from database import db
    with db() as (conn, cur):
        cur.execute("SELECT id, kart_adi FROM kartlar WHERE id=%s AND aktif=TRUE", (body.kart_id,))
        kart = cur.fetchone()
        if not kart:
            raise HTTPException(404, detail="Kart bulunamadı")

        yazilan = 0
        atlanan = 0
        for tx in body.islemler:
            aciklama_tam = tx.aciklama[:180]
            if tx.kategori:
                aciklama_tam = aciklama_tam + ' [' + tx.kategori + ']'
            aciklama_tam = aciklama_tam[:200]

            # Duplike kontrolü
            cur.execute("""
                SELECT 1 FROM kart_hareketleri
                WHERE kart_id=%s AND tarih=%s AND tutar=%s
                  AND LEFT(aciklama,60) = LEFT(%s,60)
                  AND islem_turu='HARCAMA'
                LIMIT 1
            """, (body.kart_id, tx.tarih, round(tx.tutar, 2), aciklama_tam))
            if cur.fetchone():
                atlanan += 1
                continue

            h_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO kart_hareketleri
                    (id, kart_id, tarih, islem_turu, tutar, aciklama, durum)
                VALUES (%s, %s, %s, 'HARCAMA', %s, %s, 'aktif')
            """, (h_id, body.kart_id, tx.tarih, round(tx.tutar, 2), aciklama_tam))
            yazilan += 1

        conn.commit()
    return {
        'success': True,
        'kart_adi': kart['kart_adi'],
        'yazilan': yazilan,
        'atlanan': atlanan,
        'toplam': len(body.islemler),
    }

# ─── Son 4 hane kaydet ────────────────────────────────────────────────────────
class SonDortHaneBody(BaseModel):
    kart_id: str
    son_dort_hane: str

@router.post("/kaydet-son-dort-hane")
def kaydet_son_dort_hane(body: SonDortHaneBody):
    """Kartın son 4 hanesini güncelle (PDF eşleştirme için)."""
    from database import db
    s4 = re.sub(r'[^0-9]', '', body.son_dort_hane)[-4:]
    if len(s4) != 4:
        raise HTTPException(400, detail="Geçerli 4 haneli sayı girin")
    with db() as (conn, cur):
        cur.execute("UPDATE kartlar SET son_dort_hane=%s WHERE id=%s AND aktif=TRUE",
                    (s4, body.kart_id))
        if cur.rowcount == 0:
            raise HTTPException(404, detail="Kart bulunamadı")
        conn.commit()
    return {'success': True}
