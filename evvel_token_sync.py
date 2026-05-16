"""
evvel_token_sync.py
-------------------
Chrome'daki mevcut Evo oturumundan token okur, Railway API'ye gönderir.
Windows Görev Zamanlayıcı ile her 2 saatte bir çalışır.
Kullanıcıyı oturumdan ATMAZ — mevcut sekme kullanılır.

Strateji:
1. Önce localhost:9222 (Chrome debug port) açık mı kontrol et
2. Açıksa CDP ile localStorage'dan token oku
3. Değilse ayrı Chrome profili ile evobulut'u aç, token bekle
4. Token'ı Railway'e gönder
"""

import subprocess, json, time, sys, os, urllib.request, urllib.parse
import urllib.error

RAILWAY_URL   = "https://evvel-erp-production.up.railway.app"
EVO_URL       = "https://web.evobulut.com/hizli/hs_rapor.html"
LOG_FILE      = os.path.join(os.path.dirname(__file__), "evvel_token_sync.log")
CDP_PORT      = 9222
# Ayrı Chrome profili (ana Chrome'a dokunmaz)
CHROME_PROFILE = os.path.expandvars(r"%LOCALAPPDATA%\EvvelChrome")

def log(msg):
    import datetime
    line = f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        print(line)
    except Exception:
        print(line.encode('ascii', errors='replace').decode())
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def port_ac_mi(port=CDP_PORT) -> bool:
    """CDP portu açık mı?"""
    import socket
    s = socket.socket()
    s.settimeout(2)
    try:
        s.connect(("localhost", port))
        s.close()
        return True
    except Exception:
        s.close()
        return False

def chrome_baslat():
    """Chrome'u debug portla başlatır (mevcut profil — oturumu korur)."""
    chrome_yollari = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in chrome_yollari:
        if os.path.exists(path):
            # NOT: --user-data-dir YOK → normal profil kullanılır (evobulut oturumu bozulmaz)
            args = [
                path,
                f"--remote-debugging-port={CDP_PORT}",
                "--no-first-run",
                "--no-default-browser-check",
                EVO_URL,
            ]
            subprocess.Popen(args, creationflags=subprocess.CREATE_NO_WINDOW)
            log("Chrome başlatıldı (debug portlu, normal profil)")
            return True
    log("HATA: Chrome bulunamadı!")
    return False

def token_oku_cdp(max_deneme=3) -> str | None:
    """Chrome CDP üzerinden localStorage'dan evo_token okur."""

    for deneme in range(1, max_deneme + 1):
        try:
            resp = urllib.request.urlopen(f"http://localhost:{CDP_PORT}/json", timeout=5)
            tabs = json.loads(resp.read())
            break
        except Exception as e:
            if deneme < max_deneme:
                log(f"CDP bekleniyor ({deneme}/{max_deneme})... {e}")
                time.sleep(3)
            else:
                log(f"CDP bağlantı hatası: {e}")
                return None

    # Evobulut sekmesini bul (yoksa ilk sekmeyi kullan)
    hedef = next(
        (t for t in tabs if "evobulut.com" in t.get("url", "") and t.get("type") == "page"),
        next((t for t in tabs if t.get("type") == "page"), None)
    )
    if not hedef:
        log("Chrome'da açık sekme bulunamadı")
        return None

    ws_url = hedef.get("webSocketDebuggerUrl")
    if not ws_url:
        log("WebSocket debug URL yok (sekme yükleniyor olabilir)")
        return None

    log(f"Sekme bulundu: {hedef.get('url','')[:60]}")

    # WebSocket ile localStorage'dan token oku
    import websocket
    token_sonuc = [None]
    hata_sonuc  = [None]

    def on_message(ws, msg):
        try:
            d = json.loads(msg)
            result = d.get("result", {}).get("result", {})
            val = result.get("value")
            if val and val != "null" and len(str(val)) > 10:
                token_sonuc[0] = str(val)
            else:
                hata_sonuc[0] = f"Token yok/geçersiz: {val!r}"
        except Exception as ex:
            hata_sonuc[0] = str(ex)
        finally:
            ws.close()

    def on_open(ws):
        ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": "localStorage.getItem('evo_token')"}
        }))

    def on_error(ws, err):
        hata_sonuc[0] = str(err)
        ws.close()

    try:
        ws = websocket.WebSocketApp(
            ws_url,
            on_message=on_message,
            on_open=on_open,
            on_error=on_error,
        )
        ws.run_forever(ping_timeout=10)
    except Exception as e:
        log(f"WebSocket hatası: {e}")

    if hata_sonuc[0] and not token_sonuc[0]:
        log(f"CDP hatası: {hata_sonuc[0]}")

    return token_sonuc[0]

def token_gonder(token: str) -> bool:
    """Token'ı Railway API'ye gönderir."""
    url = f"{RAILWAY_URL}/api/evo/set-web-token?token={urllib.parse.quote(token)}"
    try:
        resp = urllib.request.urlopen(url, timeout=15)
        d = json.loads(resp.read())
        ok = d.get("durum") == "ok"
        if ok:
            log(f"Railway'e gönderildi ✅ ({token[:8]}...)")
        else:
            log(f"Railway yanıtı beklenmedik: {d}")
        return ok
    except urllib.error.HTTPError as e:
        log(f"Railway HTTP hatası {e.code}: {e.read()[:200]}")
        return False
    except Exception as e:
        log(f"Railway gönderme hatası: {e}")
        return False

def railway_token_kontrol() -> bool:
    """Railway'deki token hâlâ geçerli mi?"""
    try:
        url = f"{RAILWAY_URL}/api/evo/hs-rapor?tarih1=01.01.2024&tarih2=01.01.2024&_kontrol=1"
        req = urllib.request.Request(url, headers={"User-Agent": "EvvelSync/1.0"})
        resp = urllib.request.urlopen(req, timeout=10)
        d = json.loads(resp.read())
        # Eğer veri geliyorsa token geçerli
        return bool(d.get("urunler") is not None)
    except Exception:
        return False  # hata = token gerekli, yenile

def main():
    log("=== Evvel Token Sync başladı ===")

    # 1. Önce Railway'deki token hâlâ çalışıyor mu?
    if railway_token_kontrol():
        log("Mevcut token geçerli — yenileme gerekmedi ✓")
        sys.exit(0)

    log("Token geçersiz veya yok — yenileme başlıyor...")

    # 2. Chrome debug portu açık mı?
    port_acik = port_ac_mi()

    if not port_acik:
        log(f"CDP portu {CDP_PORT} kapalı — Chrome başlatılıyor...")
        if not chrome_baslat():
            sys.exit(1)
        # Chrome açılmasını bekle
        for i in range(12):  # 12 × 2 = 24 saniye max bekle
            time.sleep(2)
            if port_ac_mi():
                log(f"CDP portu {i*2+2} saniyede açıldı")
                break
        else:
            log("HATA: Chrome 24 saniyede başlamadı")
            sys.exit(1)

    # Sayfa yüklenmesi için kısa bekle
    time.sleep(3)

    # 3. Token oku
    token = token_oku_cdp(max_deneme=3)

    if not token:
        log("HATA: Token okunamadı (Evo'da oturum açık mı? Giriş yap ve tekrar dene)")
        sys.exit(1)

    # 4. Railway'e gönder
    if not token_gonder(token):
        log("HATA: Railway'e gönderilemedi")
        sys.exit(1)

    log("=== Sync tamamlandı ===")

if __name__ == "__main__":
    main()
