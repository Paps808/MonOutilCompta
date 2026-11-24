/**
 * Identification d'un code BIC / SWIFT (ISO 9362)
 * 1. Décodage de la structure (banque, pays, localité, agence)
 * 2. GLEIF (registre officiel des LEI, à jour) : nom légal, adresse du siège, LEI
 * 3. Secours : base libre de codes SWIFT (github.com/PeterNotenboom/SwiftCodes, licence MIT, état 2019)
 */

const BIC_RE = /^([A-Z]{4})([A-Z]{2})([A-Z0-9]{2})([A-Z0-9]{3})?$/;

let nomsPays = null;
function nomPays(cc) {
  try {
    if (!nomsPays) nomsPays = new Intl.DisplayNames(["fr"], { type: "region" });
    const n = nomsPays.of(cc);
    return n && n !== cc && !/inconnu|unknown/i.test(n) ? n : null;
  } catch {
    return null;
  }
}

function analyser(brut) {
  const code = String(brut || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = code.match(BIC_RE);
  if (!m) return { valide: false, code, erreur: "Un BIC compte 8 ou 11 caractères : 4 lettres (banque), 2 lettres (pays), 2 caractères (localité) et éventuellement 3 caractères (agence). Exemple : KCBLTZTZ ou GEBABEBBXXX." };
  const [, banque, pays, localite, agence] = m;
  const pays_nom = nomPays(pays);
  if (!pays_nom) return { valide: false, code, erreur: `Le code pays « ${pays} » (5e et 6e caractères) n'existe pas.` };
  return {
    valide: true,
    code,
    bic8: banque + pays + localite,
    bic11: banque + pays + localite + (agence || "XXX"),
    banque, pays, pays_nom, localite,
    agence: agence || "XXX",
    siege: !agence || agence === "XXX",
    test: localite[1] === "0",
    passif: localite[1] === "1",
  };
}

const cacheGleif = new Map();
async function gleif(bic11) {
  if (cacheGleif.has(bic11)) return cacheGleif.get(bic11);
  const r = await fetch(`https://api.gleif.org/api/v1/lei-records?filter%5Bbic%5D=${bic11}&page%5Bsize%5D=1`, {
    headers: { Accept: "application/vnd.api+json" }, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("GLEIF HTTP " + r.status);
  const d = (await r.json()).data || [];
  let res = null;
  if (d.length) {
    const a = d[0].attributes, e = a.entity;
    const ad = e.headquartersAddress || e.legalAddress || {};
    res = {
      nom: e.legalName && e.legalName.name,
      adresse: [...(ad.addressLines || []), [ad.postalCode, ad.city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      ville: ad.city || null,
      lei: a.lei,
      statutLei: a.registration && a.registration.status,
      actif: e.status === "ACTIVE",
    };
  }
  if (cacheGleif.size > 2000) cacheGleif.clear();
  cacheGleif.set(bic11, res);
  return res;
}

const cachePays = new Map();
async function baseLibre(pays) {
  if (cachePays.has(pays)) return cachePays.get(pays);
  const r = await fetch(`https://raw.githubusercontent.com/PeterNotenboom/SwiftCodes/master/AllCountries/${pays}.json`, {
    signal: AbortSignal.timeout(12000),
  });
  const liste = r.ok ? ((await r.json()).list || []) : [];
  cachePays.set(pays, liste);
  return liste;
}

async function identifierBic(brut) {
  const b = analyser(brut);
  if (!b.valide) return b;
  const res = { ...b, sources: [] };

  // 1. GLEIF : code exact, puis siège principal si le code d'agence n'y figure pas
  try {
    let g = await gleif(b.bic11);
    if (!g && !b.siege) {
      g = await gleif(b.bic8 + "XXX");
      if (g) res.viaSiege = true;
    }
    if (g) {
      Object.assign(res, { nom: g.nom, adresse: g.adresse, ville: g.ville, lei: g.lei, statutLei: g.statutLei, actif: g.actif });
      res.sources.push("GLEIF (registre mondial des LEI)");
    }
  } catch { /* GLEIF indisponible : on poursuit avec la base libre */ }

  // 2. Base libre : complète le nom de l'agence et la ville, ou identifie la banque si la GLEIF l'ignore
  try {
    const liste = await baseLibre(b.pays);
    const exact = liste.find((x) => x.swift_code === b.code || x.swift_code === b.bic11 || (b.siege && x.swift_code === b.bic8));
    const siege = liste.find((x) => x.swift_code === b.bic8 || x.swift_code === b.bic8 + "XXX");
    const trouve = exact || siege;
    if (trouve) {
      if (!res.nom) { res.nom = trouve.bank; res.sources.push("base SWIFT libre (état 2019)"); }
      if (!res.ville && trouve.city) res.ville = trouve.city;
      if (exact && exact.branch) res.nomAgence = exact.branch;
    }
  } catch { /* base libre indisponible */ }

  res.trouve = !!res.nom;
  return res;
}

module.exports = { identifierBic, analyserBic: analyser };
