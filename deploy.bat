@echo off
cd /d "%~dp0"
git add .
set /p msg="Commit mesaji (Enter = 'guncelleme'): "
if "%msg%"=="" set msg=guncelleme
git commit -m "%msg%"
git push
echo.
echo Deploy baslatildi. Railway otomatik build edecek.
pause
