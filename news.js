/**
 * Actualités fiscales & comptables belges : agrégation quotidienne de Google Actualités
 * (requêtes thématiques en français, édition Belgique), filtrées, dédoublonnées et classées.
 */

const SECTIONS = [
  {
    id: "lois", titre: "Nouvelles lois & règles", icone: "⚖️",
    q: 'Belgique ("projet de loi" OR "Moniteur belge" OR "loi-programme" OR "nouvelle règle" OR circulaire OR réforme) (fiscal OR impôt OR TVA OR taxe) when:30d',
    filtre: /loi|r[ée]forme|circulaire|Moniteur|r[èe]gle|accord|budget|gouvernement|mesure|d[ée]cret|vot[ée]|vigueur|nouve(au|lle)|recours|Cour/i,
  },
  {
    id: "trading", titre: "Trading & placements", icone: "📈",
    q: 'Belgique ("plus-values" OR "taxe sur les comptes-titres" OR TOB OR crypto OR bourse OR dividendes OR "épargne-pension") (taxe OR impôt OR fiscal) when:30d',
    filtre: /plus-value|bourse|crypto|TOB|comptes?-titres|actions?\b|dividende|placement|investi|[ée]pargne|bons? d'[ÉE]tat|fonds|patrimoine|trading/i,
  },
  {
    id: "immo", titre: "Immobilier & logement", icone: "🏠",
    q: 'Belgique ("droits d\'enregistrement" OR "bonus logement" OR "chèque habitat" OR "prêt hypothécaire" OR "précompte immobilier" OR "droits de succession") when:30d',
    filtre: /enregistrement|hypoth|pr[ée]compte|succession|donation|bonus|ch[èe]que|immobili|propri[ée]taire|achat|loyer|r[ée]novation|prime/i,
  },
  {
    id: "compta", titre: "Comptabilité & entreprises", icone: "🧾",
    q: 'Belgique (TVA OR "facturation électronique" OR Peppol OR comptable OR "expert-comptable" OR ISOC OR "impôt des sociétés" OR indépendants) when:30d',
    filtre: /TVA|factur|Peppol|comptab|ISOC|soci[ée]t[ée]s|ind[ée]pendant|entreprise|PME|cotisation|ITAA|bilan|d[ée]claration/i,
  },
  {
    id: "fiscal", titre: "Dernières infos fiscales", icone: "🇧🇪",
    q: 'Belgique (fiscalité OR impôts OR "SPF Finances" OR "déclaration fiscale" OR "réforme fiscale") when:7d',
    filtre: /./,
  },
];

// Médias belges reconnus ; à défaut, le titre doit situer l'info en Belgique
const MEDIAS_BE = /L'Echo|Le Soir|La Libre|RTBF|7sur7|DH|Dernière Heure|Trends|21News|L'Avenir|Sudinfo|SudPresse|Business AM|Moustique|Le Vif|Belga|BX1|RTL|Bruzz|Télésambre|Notélé|Canal ?Zoom|Vivre ?Ici|TV ?Lux|Matélé|Antenne Centre|Test[- ]Achats|Wikifin|SPF|ITAA|UCM|Fiscalnet|Monkey|Gondola|Plus Magazine|Références|Mes Aides Financières|De Tijd|Lecho|Lesoir|Lalibre|Paris Match Belgique|Metro|Le Guide Social|Moniteur/i;
const MENTION_BE = /belg|bruxell|wallon|flandre|flamand|f[ée]d[ée]ral|SPF|De Wever|Arizona|Vooruit|N-VA|\bMR\b|Engag[ée]s|Jambon|Bouchez|r[ée]gion/i;

// Le titre doit parler de fiscalité, de finances ou d'entreprise : écarte le bruit des requêtes larges
const PERTINENT = /fisc|imp[oô]t|tax|TVA|SPF Finances|d[ée]duc|pr[ée]compte|ISOC|IPP|plus-value|droits? d|succession|donation|enregistrement|bonus|hypoth|logement|comptab|factur|Peppol|budget|loi|cotisation|pension|salaire|paie|bourse|crypto|[ée]pargne|placement|dividende|Moniteur|r[ée]forme|ind[ée]pendant|entreprise|patrimoine|accises|douane/i;

const PAR_SECTION = 8;
const CACHE_MS = 3 * 3600 * 1000;
let cache = null;

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}

async function fetchSection(section) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(section.q)}&hl=fr&gl=BE&ceid=BE:fr`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 MonOutilCompta" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const xml = await r.text();
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
    const source = tag(it, "source");
    let titre = tag(it, "title");
    if (source && titre.endsWith(" - " + source)) titre = titre.slice(0, -(source.length + 3));
    return { titre, source, lien: tag(it, "link"), date: new Date(tag(it, "pubDate")).toISOString() };
  });
}

const cle = (t) => t.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "").slice(0, 60);

async function getNews() {
  if (cache && Date.now() - cache.ts < CACHE_MS) return cache.data;
  const resultats = await Promise.allSettled(SECTIONS.map(fetchSection));
  const vus = new Set();
  const sections = SECTIONS.map((s, i) => {
    const bruts = resultats[i].status === "fulfilled" ? resultats[i].value : [];
    const items = bruts
      .filter((a) => a.titre && PERTINENT.test(a.titre) && s.filtre.test(a.titre))
      .filter((a) => MEDIAS_BE.test(a.source) || MENTION_BE.test(a.titre))
      .sort((a, b) => b.date.localeCompare(a.date))
      .filter((a) => { const k = cle(a.titre); if (vus.has(k)) return false; vus.add(k); return true; })
      .slice(0, PAR_SECTION);
    return { id: s.id, titre: s.titre, icone: s.icone, items };
  });
  // les rubriques spécifiques sont traitées d'abord (dédoublonnage), mais affichées dans cet ordre
  const ORDRE = ["fiscal", "compta", "lois", "trading", "immo"];
  sections.sort((a, b) => ORDRE.indexOf(a.id) - ORDRE.indexOf(b.id));
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  // si toutes les sources échouent, on garde la dernière version connue plutôt qu'une page vide
  if (!total && cache) return cache.data;
  const data = { majLe: new Date().toISOString(), sections };
  cache = { ts: Date.now(), data };
  return data;
}

module.exports = { getNews };
