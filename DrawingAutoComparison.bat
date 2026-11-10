@echo off
chcp 65001 >nul
title Drawing Auto Comparison
cd /d "%~dp0backend"
python run_app.py
if errorlevel 1 pause
