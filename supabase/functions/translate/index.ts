// Traduction MonOutilCompta : DeepL (clé lue dans le coffre private.app_secrets), secours MyMemory.
// Applique les mêmes règles d'accès que le site : mode payant actif => compte requis + quota 'trad'.

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// token : jeton de l'utilisateur ; sinon appel avec la clé de service (nouveau format sb_secret_ ou ancien JWT)
async function rpc(name: string, args: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.apikey = ANON;
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers.apikey = SERVICE;
    if (SERVICE.startsWith("eyJ")) headers.Authorization = `Bearer ${SERVICE}`;
  }
  const r = await fetch(`${URL_SB}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args ?? {}) });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

let cleDeepL: string | null = null;
let paywall = { valeur: true, ts: 0 };

async function paywallActif() {
  if (Date.now() - paywall.ts < 30000) return paywall.valeur;
  try {
    const s = await rpc("get_public_settings", {}, ANON);
    paywall = { valeur: s.paywall_enabled !== false, ts: Date.now() };
  } catch { /* garde la dernière valeur connue */ }
  return paywall.valeur;
}

const CIBLES: Record<string, string> = { EN: "EN-GB", PT: "PT-PT" };

async function deepl(text: string, source: string, target: string) {
  if (!cleDeepL) cleDeepL = (await rpc("get_app_secret", { p_key: "DEEPL_API_KEY" })) || "";
  if (!cleDeepL) throw new Error("clé absente du coffre");
  const host = cleDeepL.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const body: Record<string, unknown> = { text: [text], target_lang: CIBLES[target] || target };
  if (source && source !== "auto") body.source_lang = source;
  const r = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${cleDeepL}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 456) throw new Error("QUOTA_DEEPL");
  if (r.status === 403) { cleDeepL = null; throw new Error("clé DeepL refusée"); }
  if (!r.ok) throw new Error(`DeepL HTTP ${r.status}`);
  const j = await r.json();
  return { text: j.translations[0].text, detected: j.translations[0].detected_source_language || null, engine: "DeepL" };
}

async function secours(text: string, source: string, target: string) {
  if (text.length > 500) throw new Error("Traduction momentanément indisponible pour les textes de plus de 500 caractères. Réessayez dans un instant.");
  const pair = `${source === "auto" ? "Autodetect" : source}|${target}`;
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`);
  const j = await r.json();
  if (!j.responseData || j.responseStatus !== 200 || j.quotaFinished || /^MYMEMORY WARNING/i.test(j.responseData.translatedText || "")) {
    throw new Error("Traduction momentanément indisponible. Réessayez dans un instant.");
  }
  return { text: j.responseData.translatedText, detected: (j.responseData.detectedLanguage || "").toUpperCase() || null, engine: "moteur de secours" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Méthode non autorisée" });

  let corps: { text?: string; source?: string; target?: string };
  try { corps = await req.json(); } catch { return json(400, { error: "Requête invalide." }); }
  const text = String(corps.text || "").slice(0, 5000);
  const source = String(corps.source || "auto").toUpperCase() === "AUTO" ? "auto" : String(corps.source).toUpperCase().slice(0, 2);
  const target = String(corps.target || "EN").toUpperCase().slice(0, 2);
  if (!text.trim()) return json(400, { error: "Aucun texte à traduire." });

  if (await paywallActif()) {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    if (!token || token === ANON) return json(401, { code: "AUTH_REQUIRED", error: "Créez un compte gratuit pour utiliser cet outil." });
    try {
      const q = await rpc("consume_quota", { kind: "trad" }, token);
      if (!q.allowed) {
        if (q.reason === "quota") return json(402, { code: "QUOTA_EXCEEDED", used: q.used, limit: q.limit, error: "Quota gratuit du mois épuisé." });
        return json(401, { code: "AUTH_REQUIRED", error: "Connectez-vous pour utiliser cet outil." });
      }
    } catch {
      return json(401, { code: "AUTH_REQUIRED", error: "Session expirée, reconnectez-vous." });
    }
  }

  try {
    return json(200, await deepl(text, source, target));
  } catch (e) {
    const raison = (e as Error).message;
    if (raison === "QUOTA_DEEPL") return json(502, { error: "Le quota mensuel DeepL est épuisé." });
    try {
      return json(200, { ...(await secours(text, source, target)), raison });
    } catch (e2) {
      return json(502, { error: (e2 as Error).message, raison });
    }
  }
});
