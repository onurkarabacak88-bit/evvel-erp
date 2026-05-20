@echo off
cd /d "%~dp0"

echo [1/4] Degisiklikler ekleniyor...
git add .

set /p msg="Commit mesaji (Enter = 'guncelleme'): "
if "%msg%"=="" set msg=guncelleme
git commit -m "%msg%"
if errorlevel 1 (
    echo Commit edilecek degisiklik yok, push devam ediyor...
)

echo [2/4] Uzak degisiklikler cekiliyor (pull --rebase)...
git pull --rebase origin main
if errorlevel 1 (
    echo.
    echo HATA: Pull/rebase basarisiz. Conflict var mi kontrol edin.
    pause
    exit /b 1
)

echo [3/4] GitHub'a push ediliyor...
git push origin HEAD:main
if errorlevel 1 (
    echo.
    echo HATA: Push basarisiz oldu.
    pause
    exit /b 1
)

echo.
echo [4/4] Deploy baslatildi! Railway otomatik build edecek (~60 sn).
echo ======================================================
pause
