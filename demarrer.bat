@echo off
title MonOutilCompta (MOC) - serveur local
cd /d "%~dp0"
echo Demarrage de MonOutilCompta (MOC)...
echo Ouvrez ensuite http://localhost:3001/ dans votre navigateur.
start "" http://localhost:3001/
node server.js
pause
