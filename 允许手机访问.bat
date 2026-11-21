@echo off
chcp 65001 >nul
title 背单词练习 · 放行局域网访问（8111）
echo 这个脚本只做一件事：在 Windows 防火墙里放行 TCP 8111 端口（专用网络），
echo 这样同一 Wi-Fi 下的手机才能打开电脑上的背单词练习。
echo.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限，正在重新以管理员身份启动…
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="背单词练习 8111" >nul 2>&1
netsh advfirewall firewall add rule name="背单词练习 8111" dir=in action=allow protocol=TCP localport=8111 profile=private
if %errorlevel% equ 0 (
  echo.
  echo 已放行 8111 端口（专用网络）。现在让手机连同一个 Wi-Fi，扫码即可。
) else (
  echo.
  echo 放行失败，请检查是否有安全软件拦截了 netsh。
)
echo.
pause
