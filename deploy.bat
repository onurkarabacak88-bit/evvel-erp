@echo off
setlocal
cd /d "%~dp0"

echo ======================================================
echo EVVEL ERP - Guvenli deploy
echo ======================================================
echo.

for /f "delims=" %%b in ('git branch --show-current') do set current_branch=%%b
if not "%current_branch%"=="main" (
    echo HATA: Su an "%current_branch%" branch'indesiniz.
    echo Canli deploy sadece main branch uzerinden yapilmali.
    echo Once dogru branch'e gecin veya degisikligi main'e alin.
    pause
    exit /b 1
)

echo [1/5] Git durumu kontrol ediliyor...
git status --short
echo.

for /f %%c in ('git status --short ^| findstr /r "^??" ^| find /c /v ""') do set untracked_count=%%c
if not "%untracked_count%"=="0" (
    echo HATA: Takip edilmeyen dosyalar var.
    echo.
    echo Bu script artik "git add ." kullanmiyor.
    echo Yeni dosyalari bilerek eklemek icin once su komutu kullanin:
    echo   git add DOSYA_ADI
    echo.
    echo Ozellikle tmp/, ekran goruntusu, deneme assetleri ve gizli dosyalar canliya karismamali.
    pause
    exit /b 1
)

for /f %%c in ('git diff --name-only ^| find /c /v ""') do set unstaged_count=%%c
if not "%unstaged_count%"=="0" (
    echo HATA: Stage edilmemis degisiklikler var.
    echo.
    echo Deploy edilecek dosyalari bilerek secin:
    echo   git add DOSYA_ADI
    echo.
    echo Sonra bu deploy scriptini tekrar calistirin.
    pause
    exit /b 1
)

for /f %%c in ('git diff --cached --name-only ^| find /c /v ""') do set staged_count=%%c

if "%staged_count%"=="0" (
    echo Stage edilmis yeni degisiklik yok.
    set /p continue_push="Sadece mevcut main'i push etmeye devam edilsin mi? (E/H): "
    if /i not "%continue_push%"=="E" (
        echo Islem iptal edildi.
        pause
        exit /b 1
    )
) else (
    echo [2/5] Secilmis degisiklikler commit ediliyor...
    git diff --cached --name-only
    echo.
    set /p msg="Commit mesaji (Enter = 'guncelleme'): "
    if "%msg%"=="" set msg=guncelleme
    git commit -m "%msg%"
    if errorlevel 1 (
        echo HATA: Commit basarisiz oldu.
        pause
        exit /b 1
    )
)

echo.
echo [3/5] Build kontrolu yapiliyor...
if exist package.json (
    call npm run build
    if errorlevel 1 (
        echo.
        echo HATA: Frontend build basarisiz. Push yapilmadi.
        pause
        exit /b 1
    )
) else (
    echo package.json bulunamadi, build adimi atlandi.
)

echo.
echo [4/5] Uzak main ile esitleniyor...
git pull --rebase origin main
if errorlevel 1 (
    echo.
    echo HATA: Pull/rebase basarisiz. Conflict var mi kontrol edin.
    pause
    exit /b 1
)

echo.
echo [5/5] GitHub main branch'ine push ediliyor...
git push origin main
if errorlevel 1 (
    echo.
    echo HATA: Push basarisiz oldu.
    pause
    exit /b 1
)

echo.
echo Deploy baslatildi. Railway main branch'i uzerinden otomatik build edecek.
echo ======================================================
pause
