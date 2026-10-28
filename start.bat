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

set GPORT=%PORT%
if not defined GPORT set GPORT=3456

rem 画面なしで動いている(autostart.ps1 で自動起動した)ときは、ブラウザを開くだけにする
node -e "require('net').connect(%GPORT%,'127.0.0.1',()=>process.exit(0)).on('error',()=>process.exit(1))"
if not errorlevel 1 (
  echo すでに起動しています。ブラウザを開きます。
  start http://localhost:%GPORT%
  exit /b 0
)

start "" cmd /c "timeout /t 2 >nul & start http://localhost:%GPORT%"
call npm start
pause
