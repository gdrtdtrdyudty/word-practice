@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 背单词练习 · 本地服务
echo ============================================
echo   背单词练习  正在启动...
echo   服务地址: http://127.0.0.1:8111
echo   首次使用请到页面【设置】填入 DeepSeek API Key
echo   关闭此窗口即停止服务
echo ============================================
start "" http://127.0.0.1:8111
node server.js
pause
