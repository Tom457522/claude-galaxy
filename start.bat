@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 初回セットアップ: 依存パッケージをインストールします...
  call npm install
  if errorlevel 1 (
    echo npm install に失敗しました。
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 2 >nul & start http://localhost:3456"
call npm start
pause
