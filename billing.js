/**
 * MonOutilCompta — comptes, quotas et abonnements
 * - Comptes & sessions : Supabase Auth (les mots de passe ne touchent jamais ce serveur)
 * - Quotas gratuits : fonctions Postgres (consume_quota / account_status) appelées avec le jeton de l'utilisateur
 * - Paiements : Stripe Checkout + webhook (clés via variables d'environnement ou config.json local)
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const localConfig = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); }
  catch { return {}; }
})();
const cfg = (k, d = "") => process.env[k] || localConfig[k] || d;

// Valeurs publiques par conception (l'anon key Supabase est faite pour être exposée au navigateur)
const SUPABASE_URL = cfg("SUPABASE_URL", "https://qiunqrtexuvfewpttcvv.supabase.co");
const SUPABASE_ANON_KEY = cfg("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpdW5xcnRleHV2ZmV3cHR0Y3Z2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDI4MzMsImV4cCI6MjA5OTc3ODgzM30.iFQzD-IFKUTYQT7zkEUMC5xJaqEWinaALpdlHn7jfJc");
// Secrets (jamais dans le code ni dans git)
const SUPABASE_SERVICE_KEY = cfg("SUPABASE_SERVICE_KEY");
const STRIPE_SECRET_KEY = cfg("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = cfg("STRIPE_WEBHOOK_SECRET");
const DEEPL_API_KEY = cfg("DEEPL_API_KEY");

const PRICES = {
  monthly: { amount: 499, interval: "month", lookup: "moc_monthly", label: "4,99 € / mois" },
  yearly: { amount: 4900, interval: "year", lookup: "moc_yearly", label: "49 € / an" },
};

/* ---------- Supabase ---------- */

function bearerToken(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

const tokenCache = new Map(); // token -> { user, expires }
async function getUser(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  tokenCache.set(token, { user, expires: Date.now() + 5 * 60 * 1000 });
  if (tokenCache.size > 1000) tokenCache.clear();
  return user;
}

async function rpc(name, token, args = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`Supabase ${name} : ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// État du mode payant (cache 30 s pour ne pas interroger la base à chaque requête)
let paywallCache = { value: true, ts: 0 };
async function paywallEnabled() {
  if (Date.now() - paywallCache.ts < 30000) return paywallCache.value;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_settings`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}`, "content-type": "application/json" },
      body: "{}",
    });
    if (r.ok) {
      const j = await r.json();
      paywallCache = { value: j.paywall_enabled !== false, ts: Date.now() };
    }
  } catch { /* en cas de doute on garde la dernière valeur connue */ }
  return paywallCache.value;
}

// Bascule ON/OFF du mode payant — administrateur uniquement
async function setPaywall(req, enabled) {
  const token = bearerToken(req);
  if (!token) return { status: 401, body: { error: "Connexion requise" } };
  try {
    const r = await rpc("set_paywall", token, { p_enabled: !!enabled });
    if (r && r.error === "forbidden") return { status: 403, body: { error: "Réservé à l'administrateur" } };
    paywallCache = { value: !!enabled, ts: Date.now() }; // effet immédiat sur ce serveur
    return { status: 200, body: r };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

// Vérifie l'accès à un outil : abonné = illimité, sinon quota gratuit mensuel
async function consumeQuota(req, kind) {
  if (!(await paywallEnabled())) return { allowed: true, paywallOff: true }; // site en accès libre
  const token = bearerToken(req);
  if (!token) return { allowed: false, reason: "auth" };
  const user = await getUser(token);
  if (!user) return { allowed: false, reason: "auth" };
  try {
    return await rpc("consume_quota", token, { kind });
  } catch (e) {
    return { allowed: false, reason: "error", error: e.message };
  }
}

// Journalisation d'un événement de fréquentation (fonctionne aussi sans compte)
async function trackEvent(req, body) {
  const token = bearerToken(req) || SUPABASE_ANON_KEY;
  const args = {
    p_type: String(body.type || "").slice(0, 20),
    p_name: String(body.name || "").slice(0, 80),
    p_lang: String(body.lang || "").slice(0, 8),
    p_path: String(body.path || "").slice(0, 120),
    p_session: String(body.session || "").slice(0, 40),
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_event`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  return r.ok;
}

// Statistiques agrégées — réservé au compte administrateur
async function adminStats(req) {
  const token = bearerToken(req);
  if (!token) return { status: 401, body: { error: "Connexion requise" } };
  try {
    const stats = await rpc("admin_stats", token);
    if (stats && stats.error === "forbidden") {
      return { status: 403, body: { error: "Réservé à l'administrateur" } };
    }
    return { status: 200, body: stats };
  } catch (e) {
    return { status: 502, body: { error: e.message } };
  }
}

async function accountStatus(req) {
  const token = bearerToken(req);
  if (!token) return { authenticated: false };
  const user = await getUser(token);
  if (!user) return { authenticated: false };
  const status = await rpc("account_status", token);
  return { ...status, email: user.email };
}

// Écriture des abonnements (webhook Stripe) — nécessite la clé service
async function upsertSubscription(row) {
  if (!SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY manquante (variable d'environnement)");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error(`Supabase upsert : ${(await r.text()).slice(0, 200)}`);
}

/* ---------- Stripe (API directe, sans dépendance) ---------- */

async function stripeCall(pathname, params, method = "POST") {
  const url = "https://api.stripe.com" + pathname + (method === "GET" && params ? "?" + params : "");
  const r = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" && params ? new URLSearchParams(params) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error && j.error.message ? j.error.message : "Erreur Stripe");
  return j;
}

// Retrouve (ou crée au premier appel) le produit et les deux tarifs dans Stripe
let priceCache = null;
async function ensurePrices() {
  if (priceCache) return priceCache;
  const found = await stripeCall("/v1/prices", "lookup_keys[]=moc_monthly&lookup_keys[]=moc_yearly&active=true", "GET");
  const map = {};
  for (const p of found.data || []) {
    if (p.lookup_key === PRICES.monthly.lookup) map.monthly = p.id;
    if (p.lookup_key === PRICES.yearly.lookup) map.yearly = p.id;
  }
  if (!map.monthly || !map.yearly) {
    const prod = await stripeCall("/v1/products", { name: "MonOutilCompta (MOC)", description: "Accès illimité : TVA/VIES, IBAN/BIC, outils PDF, prorata" });
    for (const [plan, p] of Object.entries(PRICES)) {
      if (!map[plan]) {
        map[plan] = (await stripeCall("/v1/prices", {
          product: prod.id, currency: "eur", unit_amount: p.amount,
          "recurring[interval]": p.interval, lookup_key: p.lookup,
        })).id;
      }
    }
  }
  priceCache = map;
  return map;
}

function siteOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  return req.headers.origin || `${proto}://${req.headers.host}`;
}

async function createCheckout(req, plan) {
  const token = bearerToken(req);
  const user = token && (await getUser(token));
  if (!user) return { status: 401, body: { code: "AUTH_REQUIRED", error: "Connectez-vous d'abord." } };
  if (!STRIPE_SECRET_KEY) return { status: 501, body: { error: "Paiements pas encore configurés (clé Stripe manquante côté serveur)." } };
  if (!PRICES[plan]) return { status: 400, body: { error: "Formule inconnue." } };
  const prices = await ensurePrices();
  const origin = siteOrigin(req);
  const session = await stripeCall("/v1/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": prices[plan],
    "line_items[0][quantity]": "1",
    success_url: `${origin}/?abonnement=ok`,
    cancel_url: `${origin}/?abonnement=annule`,
    client_reference_id: user.id,
    customer_email: user.email,
    "subscription_data[metadata][user_id]": user.id,
    allow_promotion_codes: "true",
  });
  return { status: 200, body: { url: session.url } };
}

async function createPortal(req) {
  const token = bearerToken(req);
  const user = token && (await getUser(token));
  if (!user) return { status: 401, body: { code: "AUTH_REQUIRED", error: "Connectez-vous d'abord." } };
  if (!STRIPE_SECRET_KEY) return { status: 501, body: { error: "Paiements pas encore configurés." } };
  // lecture de son propre abonnement (RLS) pour retrouver le client Stripe
  const r = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=stripe_customer_id`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  const rows = r.ok ? await r.json() : [];
  const customer = rows[0] && rows[0].stripe_customer_id;
  if (!customer) return { status: 404, body: { error: "Aucun abonnement trouvé pour ce compte." } };
  const session = await stripeCall("/v1/billing_portal/sessions", {
    customer, return_url: siteOrigin(req) + "/",
  });
  return { status: 200, body: { url: session.url } };
}

/* ---------- Webhook Stripe ---------- */

function verifyStripeSignature(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET || !sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch { return false; }
}

async function handleWebhook(req, rawBody) {
  if (!verifyStripeSignature(rawBody.toString("utf8"), req.headers["stripe-signature"])) {
    return { status: 400, body: { error: "Signature invalide" } };
  }
  const event = JSON.parse(rawBody.toString("utf8"));
  const obj = event.data && event.data.object;

  if (event.type === "checkout.session.completed" && obj && obj.subscription) {
    const sub = await stripeCall(`/v1/subscriptions/${obj.subscription}`, null, "GET");
    const interval = sub.items.data[0].price.recurring.interval;
    await upsertSubscription({
      user_id: obj.client_reference_id,
      status: "active",
      plan: interval === "year" ? "yearly" : "monthly",
      stripe_customer_id: String(obj.customer),
      stripe_subscription_id: String(obj.subscription),
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    });
  }

  if ((event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") && obj) {
    const userId = obj.metadata && obj.metadata.user_id;
    if (userId) {
      const active = obj.status === "active" || obj.status === "trialing";
      const interval = obj.items && obj.items.data[0] && obj.items.data[0].price.recurring.interval;
      await upsertSubscription({
        user_id: userId,
        status: event.type === "customer.subscription.deleted" ? "canceled" : (active ? "active" : obj.status),
        plan: interval === "year" ? "yearly" : "monthly",
        stripe_customer_id: String(obj.customer),
        stripe_subscription_id: String(obj.id),
        current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
      });
    }
  }

  return { status: 200, body: { received: true } };
}

module.exports = {
  SUPABASE_URL, SUPABASE_ANON_KEY, PRICES,
  STRIPE_READY: !!STRIPE_SECRET_KEY,
  consumeQuota, accountStatus, createCheckout, createPortal, handleWebhook,
  trackEvent, adminStats, paywallEnabled, setPaywall, translate,
  DEEPL_READY: !!DEEPL_API_KEY,
};

/* ---------- Traduction (DeepL si clé configurée, sinon moteur de secours MyMemory) ---------- */

const DEEPL_TARGETS = { EN: "EN-GB", PT: "PT-PT" }; // codes cibles requis par DeepL

let deeplInvalide = false; // mémorise un refus de clé pour ne plus ralentir les traductions suivantes

async function translate(text, source, target) {
  if (DEEPL_API_KEY && !deeplInvalide) {
    const hosts = DEEPL_API_KEY.endsWith(":fx")
      ? ["api-free.deepl.com"]
      : ["api.deepl.com", "api-free.deepl.com"];
    const body = { text: [text], target_lang: DEEPL_TARGETS[target] || target };
    if (source && source !== "auto") body.source_lang = source;
    for (const host of hosts) {
      try {
        const r = await fetch(`https://${host}/v2/translate`, {
          method: "POST",
          headers: { Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        });
        if (r.status === 403) continue; // clé refusée sur cet hôte : essayer l'autre
        if (r.status === 456) throw new Error("Quota mensuel DeepL épuisé.");
        if (!r.ok) continue;
        const j = await r.json();
        return {
          text: j.translations[0].text,
          detected: j.translations[0].detected_source_language || null,
          engine: "DeepL",
        };
      } catch (e) {
        if (e.message.includes("DeepL")) throw e;
      }
    }
    deeplInvalide = true; // clé refusée partout : moteur de secours direct désormais
  }
  // Secours sans clé : MyMemory (gratuit, ~500 caractères par requête)
  if (text.length > 500) {
    throw new Error("Sans clé DeepL, le moteur de secours est limité à 500 caractères par traduction.");
  }
  const pair = `${source === "auto" ? "Autodetect" : source}|${target}`;
  const r = await fetch(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`,
    { headers: { "User-Agent": "MonOutilCompta/1.0" } }
  );
  const j = await r.json();
  if (!j.responseData || j.responseStatus !== 200) {
    throw new Error("Moteur de secours indisponible : " + ((j.responseDetails || "").slice(0, 120) || "réessayez"));
  }
  return {
    text: j.responseData.translatedText,
    detected: (j.responseData.detectedLanguage || "").toUpperCase() || null,
    engine: DEEPL_API_KEY
      ? "moteur de secours (clé DeepL refusée — vérifiez votre clé API)"
      : "moteur de secours (qualité réduite — clé DeepL non configurée)",
  };
}
