<p align="center">
  <img src="logo.svg" alt="MonOutilCompta" width="420">
</p>

<p align="center">
  <b>La boîte à outils en ligne des comptables et des entreprises belges.</b><br>
  Actualités fiscales · Vérification TVA (VIES / BCE) · IBAN & BIC · Devises · Outils PDF · Traduction · Prorata
</p>

<p align="center">
  <a href="https://monoutilcompta.onrender.com"><b>monoutilcompta.onrender.com</b></a>
</p>

---

## Fonctionnalités

### 📰 Actualités (page d'accueil)
- Les infos fiscales et comptables belges du jour, triées en rubriques : **dernières infos fiscales**, **comptabilité & entreprises**, **nouvelles lois & règles**, **trading & placements**, **immobilier & logement**.
- Sélection automatique dans la presse belge (L'Echo, Le Soir, La Libre, RTBF, Trends-Tendances…) via Google Actualités, avec filtres de pertinence par rubrique et suppression des doublons. Actualisé toutes les 3 heures.
- Colonne **« Marchés en direct »** alimentée par des chaînes Telegram publiques (messages économiques uniquement), actualisée toutes les 15 minutes.
- **Conseil du jour** : une règle fiscale ou comptable utile, différente chaque jour.

### 🏢 Vérification TVA
- Contrôle du format pays par pays, puis vérification officielle **VIES** (Commission européenne) pour les 27 pays de l'UE et l'Irlande du Nord (`XI`).
- Saisie souple : `BE0403199702`, `0403.199.702` (sans préfixe = belge), `be 0403-199-702`…
- Numéros belges : fiche **BCE** en plus (statut, forme légale, siège, date de début, unités d'établissement).
- Numéros français : si VIES est saturé, contrôle de la clé TVA et identification via l'**Annuaire des entreprises** (INSEE / RNE).
- Royaume-Uni (`GB`) : contrôle du format et lien vers le vérificateur officiel gov.uk.

### 🏦 IBAN & BIC
- Validation IBAN pour ~85 pays : longueur officielle, clé modulo 97, clés nationales belge et française (RIB).
- Identification automatique de la banque et du **BIC** à partir de l'IBAN pour la plupart des pays européens.
- **Identification d'un code BIC / SWIFT** (8 ou 11 caractères) : nom de la banque, adresse du siège, pays, agence et LEI, via le registre officiel **GLEIF**, complété par une base libre de codes SWIFT. Signale les codes de test et les participants non connectés au réseau SWIFT.

### 💱 Devises
- Convertisseur bidirectionnel au **taux de référence BCE**, en direct ou à une date passée (depuis 1999), avec tableaux de conversion croisés.
- ~160 devises mondiales au taux de marché du jour (ExchangeRate-API).
- Tableau des taux de l'euro publiés par la BCE et table des codes devises ISO 4217 par pays.

### 📄 Outils PDF
Diviser (sélection des pages sur miniatures), fusionner, compresser, PDF → Word, PDF → JPG, images → PDF, pivoter, filigrane, numéros de page et OCR.
Tout est traité **dans le navigateur** : les documents ne sont jamais envoyés sur un serveur (sauf la conversion Word haute fidélité, qui passe par le serveur).

### 🌐 Traduction
- Traduction **DeepL** en direct pendant la frappe (FR, NL, EN, DE, ES, IT, PT, PL), avec détection automatique de la langue.
- Dictionnaire pour les mots seuls (définitions du Wiktionnaire et traductions alternatives) et lecture à voix haute.

### 📐 Prorata
Prorata temporis avec répartition par année civile, règle de trois, et prorata général de déduction TVA pour les assujettis mixtes.

### 👤 Comptes, abonnements et administration
- Comptes utilisateurs (inscription, connexion, mot de passe oublié) avec quotas gratuits mensuels : 5 vérifications TVA, 5 IBAN/BIC, 2 opérations PDF, 10 traductions.
- Abonnements illimités via **Stripe** : 4,99 €/mois ou 49 €/an.
- Tableau de bord administrateur : statistiques de fréquentation et d'usage des outils, et interrupteur pour activer ou désactiver le mode payant (accès libre total quand il est désactivé).

### 🎨 Interface
Thème sombre ou clair, site en français, néerlandais ou anglais, adapté au mobile.

---

## Architecture

| Élément | Rôle |
|---|---|
| `server.js` | Serveur Node.js **sans dépendance** : pages, API, compression gzip |
| `index.html` | Interface complète (page unique) |
| `billing.js` | Comptes, quotas, Stripe, statistiques, taux de change, traduction de secours |
| `news.js` | Agrégation des actualités (Google Actualités + Telegram) |
| `bic.js` | Identification des codes BIC / SWIFT |
| `pdf2word.py` | Conversion PDF → Word haute fidélité (`pdf2docx`) |
| `supabase/functions/translate` | Fonction Supabase de traduction DeepL (la clé reste côté Supabase) |
| `Dockerfile`, `render.yaml` | Déploiement sur Render (Node + Python) |

Services externes : **Supabase** (comptes, base de données, fonction de traduction), **Render** (hébergement), **Stripe** (paiements), **DeepL**, **VIES**, **GLEIF**, **BCE / Frankfurter**, **ExchangeRate-API**, **Google Actualités**.

### Routes de l'API

| Route | Description |
|---|---|
| `GET /api/news` | Actualités par rubrique + fil Telegram |
| `GET /api/vies/:pays/:numero` | Vérification d'un numéro de TVA |
| `GET /api/bce/:numero` | Fiche BCE d'une entreprise belge |
| `GET /api/iban/:iban` | Validation IBAN et identification de la banque |
| `GET /api/bic/:code` | Identification d'un code BIC / SWIFT |
| `GET /api/fx/:devise` | Taux de marché du jour |
| `POST /api/translate` | Traduction (repli si la fonction Supabase est injoignable) |
| `POST /api/pdf2word` | Conversion PDF → Word |
| `GET /api/me`, `GET /api/config` | État du compte, configuration publique |
| `POST /api/billing/checkout`, `/portal` | Abonnement Stripe, gestion de l'abonnement |
| `POST /api/stripe/webhook` | Événements Stripe |
| `GET /api/admin/stats`, `POST /api/admin/paywall` | Administration (compte administrateur uniquement) |
| `GET /api/health`, `GET /api/diag` | Surveillance du service |

---

## Lancer le projet en local

Prérequis : **Node.js 18 ou plus**. Python et `pdf2docx` sont facultatifs (conversion Word haute fidélité).

```bash
git clone https://github.com/Paps808/MonOutilCompta.git
cd MonOutilCompta
node server.js
```

Puis ouvrir http://localhost:3001. Sous Windows, `demarrer.bat` lance le serveur et ouvre le navigateur.

Pour la conversion Word haute fidélité :

```bash
pip install pdf2docx
```

### Configuration

Les clés se donnent par **variables d'environnement** (sur Render : *Environment*) ou, en local, dans un fichier `config.json` à la racine. Ce fichier est exclu de Git : **ne jamais publier de clé dans le dépôt**.

| Variable | Utilité |
|---|---|
| `SUPABASE_SERVICE_KEY` | Activation des abonnements par le webhook Stripe |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Paiements et abonnements |
| `EXCHANGERATE_API_KEY` | Devises hors BCE (~125 devises supplémentaires) |
| `DEEPL_API_KEY` | Traduction de secours côté serveur (la traduction principale passe par Supabase) |
| `PORT` | Port d'écoute (fourni automatiquement par Render) |

La clé DeepL utilisée par la fonction Supabase est conservée dans la table privée `private.app_secrets` du projet Supabase, inaccessible aux visiteurs.

Sans aucune clé, le site fonctionne déjà : vérification TVA, IBAN/BIC, devises BCE, outils PDF, prorata et actualités.

---

## Déploiement

Chaque `git push` sur `main` redéploie automatiquement le site sur **Render** (image Docker définie par le `Dockerfile`). Un moniteur UptimeRobot interroge `/api/health` toutes les 5 minutes, ce qui garde le service et la base Supabase actifs.

---

## Avertissement

Les informations fournies (vérifications, taux, actualités, conseils du jour) le sont à titre indicatif. Elles ne remplacent pas l'avis d'un expert-comptable ou d'un conseiller fiscal. Les articles d'actualité appartiennent à leurs médias respectifs ; le site n'en affiche que le titre et un lien vers la source.

---

<p align="center">© MonOutilsCompta 2026 ® — L.Dupz Productions</p>
