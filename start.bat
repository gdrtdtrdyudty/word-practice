@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 背单词练习 · 本地服务
echo ============================================
echo   背单词练习  正在启动...
echo   电脑上打开: http://127.0.0.1:8111
echo   手 机 上:   同一个 Wi-Fi 下扫码（页面【设置】-【手机扫码连接】）
echo   手机打不开？管理员运行一次「允许手机访问.bat」放行 8111 端口
echo   首次使用请到页面【设置】填入 DeepSeek API Key
echo   关闭此窗口即停止服务
echo ============================================
start "" http://127.0.0.1:8111
node server.js
pause
