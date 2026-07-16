/**
 * MonOutilCompta (MOC) — serveur local (aucune dépendance)
 * - Sert l'interface (index.html)
 * - /api/health                     -> état du serveur
 * - /api/vies/:country/:vatNumber   -> vérification TVA via VIES (proxy, évite CORS)
 * - /api/bce/:number                -> infos publiques BCE/KBO (scrape léger + lien officiel)
 * - /api/iban/:iban                 -> validation IBAN + BIC/banque (openiban + table BE)
 */
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");

const PYTHON = process.platform === "win32" ? "python" : "python3";
const billing = require("./billing.js");

// 401 = compte requis, 402 = quota gratuit épuisé
function sendQuotaError(res, q) {
  if (q.reason === "auth") {
    return sendJson(res, 401, { code: "AUTH_REQUIRED", error: "Créez un compte gratuit pour utiliser cet outil." });
  }
  if (q.reason === "quota") {
    return sendJson(res, 402, { code: "QUOTA_EXCEEDED", used: q.used, limit: q.limit, error: "Quota gratuit du mois épuisé — passez en illimité." });
  }
  return sendJson(res, 503, { error: "Vérification du compte impossible : " + (q.error || "réessayez") });
}

const PORT = Number(process.env.PORT) || 3001; // PORT est fourni par l'hébergeur en ligne (Render, Railway…)
const ROOT = __dirname;

/* ---------- utilitaires ---------- */

function fetchJson(url, { timeout = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "MonOutilCompta/1.0", Accept: "application/json", ...headers }, timeout },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, json: null, raw: data });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function fetchText(url, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OutilsPro/1.0",
          Accept: "text/html",
          "Accept-Language": "fr",
        },
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function sendCompressed(res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (res.acceptsGzip && buf.length > 512) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", "Content-Length": gz.length });
    res.end(gz);
  } else {
    res.writeHead(status, { ...headers, "Content-Length": buf.length });
    res.end(buf);
  }
}

function sendJson(res, status, obj) {
  sendCompressed(res, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }, JSON.stringify(obj));
}

/* ---------- TVA / VIES ---------- */

async function handleVies(req, res, country, vatNumber) {
  const q = await billing.consumeQuota(req, "vat");
  if (!q.allowed) return sendQuotaError(res, q);
  let cc = String(country || "").toUpperCase().replace(/[^A-Z]/g, "");
  const num = String(vatNumber || "").replace(/[^0-9A-Za-z]/g, "");
  if (!/^[A-Z]{2}$/.test(cc) || num.length < 2) {
    return sendJson(res, 400, { error: "Numéro de TVA invalide. Format attendu : BE0123456789" });
  }
  if (cc === "GR") cc = "EL"; // la Grèce utilise le préfixe EL dans VIES
  if (cc === "GB") return handleHmrc(res, num); // Royaume-Uni : hors VIES depuis le Brexit, API HMRC
  try {
    const { status, json, raw } = await fetchJson(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${num}`,
      { timeout: 15000 }
    );
    if (!json) {
      return sendJson(res, 502, { error: "Réponse VIES illisible", detail: (raw || "").slice(0, 200) });
    }
    if (json.userError && json.userError !== "VALID" && json.userError !== "INVALID") {
      return sendJson(res, 200, {
        valid: null,
        error: `Service VIES indisponible pour ce pays (${json.userError}). Réessayez plus tard.`,
      });
    }
    sendJson(res, 200, {
      valid: json.isValid === true,
      countryCode: cc,
      vatNumber: num,
      name: json.name && json.name !== "---" ? json.name : null,
      address: json.address && json.address !== "---" ? json.address : null,
      requestDate: json.requestDate || null,
      consultationNumber: json.requestIdentifier || null,
    });
  } catch (e) {
    sendJson(res, 502, { error: "Impossible de contacter le service VIES : " + e.message });
  }
}

// Royaume-Uni : depuis 2025, l'API HMRC exige une clé OAuth ; on contrôle le format
// et on renvoie le lien du vérificateur officiel gov.uk.
async function handleHmrc(res, num) {
  if (!/^\d{9}(\d{3})?$/.test(num) && !/^(GD|HA)\d{3}$/.test(num)) {
    return sendJson(res, 400, { error: "Numéro de TVA britannique invalide (9 ou 12 chiffres, ex. GB553557881)" });
  }
  sendJson(res, 200, {
    valid: null,
    countryCode: "GB",
    vatNumber: num,
    formatOk: true,
    manualUrl: "https://www.tax.service.gov.uk/check-vat-number/enter-vat-details",
    error: "Le Royaume-Uni ne fait plus partie du VIES et le service HMRC exige désormais une clé d'accès. Le format du numéro est correct — vérifiez-le en 10 secondes sur le site officiel gov.uk.",
  });
}

/* ---------- BCE / KBO (Belgique) ---------- */

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function handleBce(res, number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!/^0\d{9}$|^1\d{9}$/.test(digits)) {
    return sendJson(res, 400, { error: "Numéro d'entreprise invalide (10 chiffres, ex. 0403199702)" });
  }
  const formatted = `${digits.slice(0, 4)}.${digits.slice(4, 7)}.${digits.slice(7)}`;
  const officialUrl = `https://kbopub.economie.fgov.be/kbopub/toonondernemingps.html?ondernemingsnummer=${digits}&lang=fr`;

  const result = { number: digits, formatted, officialUrl, fields: {}, source: null };

  try {
    const { status, text } = await fetchText(officialUrl, { timeout: 12000 });
    if (status === 200 && text) {
      const labels = [
        ["Généralités", null],
        ["Statut", "statut"],
        ["Situation juridique", "situationJuridique"],
        ["Date de début", "dateDebut"],
        ["Dénomination", "denomination"],
        ["Abréviation", "abreviation"],
        ["Adresse du siège", "adresseSiege"],
        ["Numéro de téléphone", "telephone"],
        ["Adresse e-mail", "email"],
        ["Adresse web", "web"],
        ["Type d'entité", "typeEntite"],
        ["Forme légale", "formeLegale"],
        ["Nombre d'unités d'établissement", "nombreUE"],
      ];
      // La page KBO est un tableau <tr><td>Label:</td><td>Valeur</td></tr>
      const rows = text.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (const row of rows) {
        const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(stripTags);
        if (cells.length < 2) continue;
        const label = cells[0].replace(/:$/, "").trim();
        for (const [fr, key] of labels) {
          if (key && label.startsWith(fr)) {
            // valeur = cellules suivantes non vides
            const value = cells.slice(1).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
            if (value && !result.fields[key]) result.fields[key] = value;
          }
        }
      }
      if (Object.keys(result.fields).length > 0) result.source = "BCE (kbopub.economie.fgov.be)";
    }
  } catch {
    /* la BCE bloque parfois les requêtes automatiques : on renvoie le lien officiel */
  }
  sendJson(res, 200, result);
}

/* ---------- IBAN / BIC ---------- */

// Registre IBAN officiel (SWIFT) — tous les pays participants
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22,
  IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19,
  MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31,
  SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23,
  TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

// Codes banque belges (3 premiers chiffres après BE##) -> [BIC, nom]. Table indicative des banques principales.
const BE_BANKS = [
  [[0, 0], "BPOTBEB1", "bpost banque"],
  [[1, 49], "GEBABEBB", "BNP Paribas Fortis"],
  [[50, 99], "GKCCBEBB", "Belfius Banque"],
  [[103, 103], "NICABEBB", "Crelan"],
  [[190, 199], "CREGBEBB", "CBC Banque"],
  [[300, 399], "BBRUBEBB", "ING Belgique"],
  [[400, 499], "KREDBEBB", "KBC Bank"],
  [[523, 523], "TRIOBEBB", "Triodos Bank"],
  [[551, 555], "GKCCBEBB", "Belfius Banque"],
  [[651, 651], "KEYTBEBB", "Keytrade Bank"],
  [[725, 799], "KREDBEBB", "KBC Bank"],
  [[750, 756], "NICABEBB", "Crelan (ex-AXA Bank)"],
  [[973, 973], "ARSPBE22", "Argenta"],
  [[979, 979], "ARSPBE22", "Argenta"],
];

function ibanChecksumValid(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = /[0-9]/.test(ch) ? ch : (ch.charCodeAt(0) - 55).toString();
    for (const d of v) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

async function handleIban(req, res, rawIban) {
  const q = await billing.consumeQuota(req, "iban");
  if (!q.allowed) return sendQuotaError(res, q);
  const iban = String(rawIban || "").replace(/[\s.-]/g, "").toUpperCase();
  const result = {
    iban,
    formatted: iban.replace(/(.{4})/g, "$1 ").trim(),
    valid: false,
    checks: [],
    country: iban.slice(0, 2),
    bank: null,
  };

  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) {
    result.checks.push({ ok: false, label: "Format général (2 lettres + 2 chiffres + caractères)" });
    return sendJson(res, 200, result);
  }
  result.checks.push({ ok: true, label: "Format général" });

  const expectedLen = IBAN_LENGTHS[result.country];
  if (expectedLen) {
    const ok = iban.length === expectedLen;
    result.checks.push({ ok, label: `Longueur pour ${result.country} (${iban.length}/${expectedLen})` });
    if (!ok) return sendJson(res, 200, result);
  } else {
    result.checks.push({ ok: true, label: `Pays ${result.country} (longueur non vérifiée)` });
  }

  const mod97 = ibanChecksumValid(iban);
  result.checks.push({ ok: mod97, label: "Clé de contrôle IBAN (modulo 97)" });
  if (!mod97) return sendJson(res, 200, result);

  result.valid = true;

  // Spécifique France : clé RIB (banque 5 + guichet 5 + compte 11 + clé 2)
  if (result.country === "FR" || result.country === "MC") {
    const bban = iban.slice(4);
    const toDigit = (ch) => {
      if (/[0-9]/.test(ch)) return ch;
      const v = ch.charCodeAt(0) - 64; // A=1 … Z=26
      return String(v <= 9 ? v : v <= 18 ? v - 9 : v - 17); // A-I:1-9, J-R:1-9, S-Z:2-9
    };
    const b = Number(bban.slice(0, 5));
    const g = Number(bban.slice(5, 10));
    const c = Number([...bban.slice(10, 21)].map(toDigit).join(""));
    const k = Number(bban.slice(21, 23));
    const okRib = (89 * b + 15 * g + 3 * c + k) % 97 === 0;
    result.checks.push({ ok: okRib, label: "Clé RIB française" });
    result.bankCode = bban.slice(0, 5);
  }

  // Spécifique Belgique : vérification du check national + banque via table
  if (result.country === "BE") {
    const bban = iban.slice(4); // 3 banque + 7 compte + 2 check
    const base = bban.slice(0, 10);
    const check = Number(bban.slice(10));
    let r = 0;
    for (const d of base) r = (r * 10 + Number(d)) % 97;
    if (r === 0) r = 97;
    result.checks.push({ ok: r === check, label: "Clé nationale belge (modulo 97 du BBAN)" });
    const bankCode = Number(bban.slice(0, 3));
    result.bankCode = bban.slice(0, 3);
    for (const [[min, max], bic, name] of BE_BANKS) {
      if (bankCode >= min && bankCode <= max) {
        result.bank = { bic, name, source: "table locale (indicatif)" };
      }
    }
  }

  // BIC + infos banque via openiban.com (BE, DE, NL, AT, LU, LI)
  try {
    const { json } = await fetchJson(
      `https://openiban.com/validate/${iban}?getBIC=true&validateBankCode=true`,
      { timeout: 8000 }
    );
    if (json && json.bankData && (json.bankData.bic || json.bankData.name)) {
      result.bank = {
        bic: json.bankData.bic || (result.bank && result.bank.bic) || null,
        name: json.bankData.name || (result.bank && result.bank.name) || null,
        zip: json.bankData.zip || null,
        city: json.bankData.city || null,
        source: "openiban.com",
      };
    }
  } catch {
    /* hors-ligne ou pays non couvert : la table locale reste utilisée */
  }

  sendJson(res, 200, result);
}

/* ---------- PDF -> Word (pdf2docx via Python, haute fidélité) ---------- */

function readBody(req, maxBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error("Fichier trop volumineux (max 100 Mo)")); }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handlePdf2Word(req, res) {
  const q = await billing.consumeQuota(req, "pdf");
  if (!q.allowed) return sendQuotaError(res, q);
  let pdfBuf;
  try {
    pdfBuf = await readBody(req);
  } catch (e) {
    return sendJson(res, 413, { error: e.message });
  }
  if (!pdfBuf || pdfBuf.length < 100 || pdfBuf.subarray(0, 5).toString() !== "%PDF-") {
    return sendJson(res, 400, { error: "Le fichier reçu n'est pas un PDF valide." });
  }
  const id = crypto.randomBytes(8).toString("hex");
  const tmpPdf = path.join(os.tmpdir(), `moc_${id}.pdf`);
  const tmpDocx = path.join(os.tmpdir(), `moc_${id}.docx`);
  try {
    fs.writeFileSync(tmpPdf, pdfBuf);
    await new Promise((resolve, reject) => {
      execFile(PYTHON, [path.join(ROOT, "pdf2word.py"), tmpPdf, tmpDocx],
        { timeout: 180000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            if (err.code === "ENOENT") return reject(new Error("PYTHON_ABSENT"));
            return reject(new Error("Conversion échouée : " + String(stderr || err.message).slice(-300)));
          }
          resolve();
        });
    });
    const docx = fs.readFileSync(tmpDocx);
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Length": docx.length,
      "Cache-Control": "no-store",
    });
    res.end(docx);
  } catch (e) {
    if (e.message === "PYTHON_ABSENT") {
      sendJson(res, 501, { error: "Python/pdf2docx indisponible sur ce serveur — conversion simplifiée utilisée à la place.", fallback: true });
    } else {
      sendJson(res, 500, { error: e.message });
    }
  } finally {
    for (const f of [tmpPdf, tmpDocx]) { try { fs.unlinkSync(f); } catch {} }
  }
}

/* ---------- serveur ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  res.acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");

  try {
    if (parts[0] === "api") {
      if (parts[1] === "health") return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      if (parts[1] === "config") {
        return sendJson(res, 200, {
          supabaseUrl: billing.SUPABASE_URL,
          supabaseAnonKey: billing.SUPABASE_ANON_KEY,
          prices: { monthly: billing.PRICES.monthly.label, yearly: billing.PRICES.yearly.label },
          billingReady: billing.STRIPE_READY,
        });
      }
      if (parts[1] === "me") return sendJson(res, 200, await billing.accountStatus(req));
      if (parts[1] === "quota" && parts[2] === "pdf" && req.method === "POST") {
        const q = await billing.consumeQuota(req, "pdf");
        if (!q.allowed) return sendQuotaError(res, q);
        return sendJson(res, 200, q);
      }
      if (parts[1] === "billing" && parts[2] === "checkout" && req.method === "POST") {
        const body = JSON.parse((await readBody(req, 10240)).toString() || "{}");
        const r = await billing.createCheckout(req, body.plan);
        return sendJson(res, r.status, r.body);
      }
      if (parts[1] === "billing" && parts[2] === "portal" && req.method === "POST") {
        const r = await billing.createPortal(req);
        return sendJson(res, r.status, r.body);
      }
      if (parts[1] === "stripe" && parts[2] === "webhook" && req.method === "POST") {
        const raw = await readBody(req, 1024 * 1024);
        const r = await billing.handleWebhook(req, raw);
        return sendJson(res, r.status, r.body);
      }
      if (parts[1] === "vies" && parts.length === 4) return await handleVies(req, res, parts[2], parts[3]);
      if (parts[1] === "bce" && parts.length === 3) return await handleBce(res, parts[2]);
      if (parts[1] === "iban" && parts.length === 3) return await handleIban(req, res, parts[2]);
      if (parts[1] === "pdf2word" && req.method === "POST") return await handlePdf2Word(req, res);
      return sendJson(res, 404, { error: "Route API inconnue" });
    }
    // statique
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.join(ROOT, path.normalize(file));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404");
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" };
    sendCompressed(res, 200, {
      "Content-Type": (types[ext] || "application/octet-stream") + "; charset=utf-8",
      "Cache-Control": "no-cache",
    }, fs.readFileSync(filePath));
  } catch (e) {
    sendJson(res, 500, { error: "Erreur serveur : " + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`MonOutilCompta (MOC) : http://localhost:${PORT}/`);
});
