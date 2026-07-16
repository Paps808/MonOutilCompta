# MonOutilCompta (MOC) — Utiliser sur différents appareils

L'application tient en quelques fichiers (`server.js`, `index.html`, `package.json`, `demarrer.bat`),
sans aucune dépendance à installer.
Il faut un petit serveur (inclus) car les vérifications TVA/VIES, BCE et BIC passent par lui.

## Option 1 — Depuis le téléphone/tablette sur le même Wi-Fi (immédiat)

1. Sur ce PC, lancer le serveur (ou double-cliquer `demarrer.bat`) :
   ```
   node "C:\Users\l.dupriez\Documents\Prive\Pro\A.R.I.A\outils-pro\server.js"
   ```
2. Sur l'autre appareil (même réseau Wi-Fi), ouvrir :
   **http://10.2.103.14:3001/**
   (l'adresse IP du PC peut changer : la retrouver avec `ipconfig` → « Adresse IPv4 »)
3. Si la page ne répond pas, autoriser Node dans le pare-feu Windows (une seule fois,
   PowerShell **en administrateur**) :
   ```
   netsh advfirewall firewall add rule name="MonOutilCompta 3001" dir=in action=allow protocol=TCP localport=3001
   ```
   Le PC doit rester allumé avec le serveur lancé.

## Option 2 — Copier sur un autre ordinateur

1. Copier le fichier `MonOutilCompta-MOC.zip` (ou le dossier `outils-pro`) sur l'autre PC
   (clé USB, e-mail, OneDrive…).
2. Installer Node.js si absent : https://nodejs.org (version LTS).
3. Dézipper, puis double-cliquer `demarrer.bat` (ou lancer `node server.js` dans le dossier).
4. Ouvrir http://localhost:3001/

**Pour la conversion PDF → Word haute fidélité** (mise en page, images, colonnes), il faut
aussi Python sur ce PC : installer https://python.org puis exécuter une fois :
```
pip install pdf2docx
```
Sans Python, l'outil bascule automatiquement sur une conversion texte simple.

## Option 3 — Mettre en ligne (accessible partout, PC/téléphone, sans PC allumé)

Hébergement gratuit possible sur **Render.com** (le plus simple) :

1. Créer un compte sur https://render.com (gratuit).
2. Mettre le dossier sur un dépôt GitHub (ou utiliser « Deploy from a Git repository »).
3. Sur Render : **New → Web Service** → choisir le dépôt →
   - Runtime : **Node**
   - Build command : *(laisser vide)*
   - Start command : `node server.js`
4. Render fournit une adresse du type `https://monoutilcompta.onrender.com`, utilisable
   depuis n'importe quel appareil. Le serveur est déjà prêt (il lit le port via `PORT`).

Alternatives équivalentes : Railway.app, Fly.io, Glitch.

> Remarque : sur l'offre gratuite de Render, le service s'endort après 15 min
> d'inactivité — le premier chargement peut alors prendre ~30 secondes.
