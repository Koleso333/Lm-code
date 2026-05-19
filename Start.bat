@echo off
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    start "Lm-code" cmd /k "chcp 65001 >nul & python lm-cli\cli.py %*"
    exit
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "Lm-code" cmd /k "chcp 65001 >nul & py lm-cli\cli.py %*"
    exit
)

chcp 65001 >nul
echo Для запуска Lm-code, необходим Python. Установить его можно с python.org (при установке укажите галку Add to PATH)
pause
