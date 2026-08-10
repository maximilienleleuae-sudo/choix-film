// Durée de cache (secondes) selon le type d'appel TMDB — équilibre fraîcheur / réduction du
// nombre de requêtes réelles à l'API TMDB. Les données quasi-statiques (genres, plateformes,
// mots-clés, personnes) sont mises en cache longtemps ; les résultats qui varient (discover,
// recherche) beaucoup moins, pour ne jamais donner une impression de contenu figé.
function tmdbCacheTtl(path) {
  if (/^\/genre\//.test(path)) return 86400 * 7;
  if (/^\/watch\/providers\//.test(path)) return 86400 * 7;
  if (/^\/configuration/.test(path)) return 86400 * 7;
  if (/^\/search\/keyword/.test(path)) return 86400 * 7;
  if (/^\/search\/person/.test(path)) return 86400;
  if (/^\/(movie|tv)\/\d+$/.test(path)) return 3600 * 6; // détails (append_to_response inclus : credits, videos, watch/providers)
  if (/^\/discover\//.test(path)) return 600;
  if (/^\/search\/(movie|tv|multi)/.test(path)) return 3600;
  return 300;
}

// ---------------------------------------------------------------------------
// Web Push (notifications) — implémentation "maison" avec la seule WebCrypto native des
// Workers (pas de dépendance npm ni de build step). Deux briques cryptographiques :
//  1. VAPID : un JWT ES256 signé avec la clé privée du serveur, qui identifie l'app auprès
//     du service de push (FCM, Mozilla push, etc.) sans jamais transmettre la clé privée.
//  2. Chiffrement du contenu (RFC 8291 / aes128gcm) : le service de push ne doit jamais lire
//     le contenu de la notification en clair, donc on le chiffre avec une clé dérivée par
//     ECDH entre une paire de clés éphémère générée ici et la clé publique du navigateur
//     abonné (p256dh), combinée au secret d'authentification (auth) de l'abonnement.
// Les deux briques ont été validées avant écriture ici contre les vecteurs de test officiels
// de la RFC 8291 (Appendix A) et une vérification interne de signature ES256.
const KNOWN_EMAILS = ["maxous.1984@gmail.com", "mathieu.burkhart@gmail.com"];
const DISPLAY_NAMES = { "maxous.1984@gmail.com": "Max", "mathieu.burkhart@gmail.com": "Mathieu" };

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

async function generateVapidJwt(endpointOrigin, env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  const x = pub.slice(1, 33), y = pub.slice(33, 65);
  const jwk = { kty: "EC", crv: "P-256", ext: true, d: env.VAPID_PRIVATE_KEY, x: bytesToB64u(x), y: bytesToB64u(y) };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: endpointOrigin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT };
  const unsigned = bytesToB64u(new TextEncoder().encode(JSON.stringify(header))) + "." + bytesToB64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(unsigned)));
  return unsigned + "." + bytesToB64u(sig);
}

// Chiffre `payloadObj` (JSON) pour l'abonnement `sub` ({ endpoint, keys: { p256dh, auth } })
// et envoie la notification au service de push. Retourne le status HTTP de la réponse du
// service de push (404/410 = abonnement expiré, à supprimer de KV côté appelant).
async function sendWebPush(sub, payloadObj, env) {
  const ua_public = b64uToBytes(sub.keys.p256dh);
  const auth_secret = b64uToBytes(sub.keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const as_public = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));
  const uaPublicKey = await crypto.subtle.importKey("raw", ua_public, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh_secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256));

  const PRK_key = await hmacSha256(auth_secret, ecdh_secret);
  const key_info = concatBytes(new TextEncoder().encode("WebPush: info"), new Uint8Array([0]), ua_public, as_public);
  const IKM = (await hmacSha256(PRK_key, concatBytes(key_info, new Uint8Array([1])))).slice(0, 32);
  const PRK = await hmacSha256(salt, IKM);
  const cek_info = concatBytes(new TextEncoder().encode("Content-Encoding: aes128gcm"), new Uint8Array([0]));
  const CEK = (await hmacSha256(PRK, concatBytes(cek_info, new Uint8Array([1])))).slice(0, 16);
  const nonce_info = concatBytes(new TextEncoder().encode("Content-Encoding: nonce"), new Uint8Array([0]));
  const NONCE = (await hmacSha256(PRK, concatBytes(nonce_info, new Uint8Array([1])))).slice(0, 12);

  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // taille d'enregistrement 4096
  const header = concatBytes(salt, rs, new Uint8Array([65]), as_public);
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
  const cekKey = await crypto.subtle.importKey("raw", CEK, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: NONCE }, cekKey, concatBytes(plaintext, new Uint8Array([2]))));
  const body = concatBytes(header, ciphertext);

  const endpointOrigin = new URL(sub.endpoint).origin;
  const jwt = await generateVapidJwt(endpointOrigin, env);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });
  return res.status;
}

// Envoie `payloadObj` à tous les abonnés connus sauf `exceptEmail` (celui qui vient de faire
// l'action). Supprime silencieusement de KV les abonnements expirés (404/410).
async function notifyOthers(env, exceptEmail, payloadObj) {
  for (const email of KNOWN_EMAILS) {
    if (email === exceptEmail) continue;
    const raw = await env.CE_SOIR_KV.get(`push-sub:${email}`);
    if (!raw) continue;
    try {
      const status = await sendWebPush(JSON.parse(raw), payloadObj, env);
      if (status === 404 || status === 410) await env.CE_SOIR_KV.delete(`push-sub:${email}`);
    } catch (err) { /* on n'interrompt jamais la requête principale pour un échec de notif */ }
  }
}

export default {
  async fetch(request, env, ctx) {
    // Pré-vol CORS (nécessaire pour que le navigateur autorise l'appel depuis Cloudflare Pages)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    // État partagé "foyer" (déjà vu + sélection commune), stocké dans Cloudflare KV (env.CE_SOIR_KV).
    // Volontairement simple : pas de compte par utilisateur, un seul pot commun pour les 2 personnes
    // déjà authentifiées via Cloudflare Access en amont.
    if (url.pathname.startsWith("/shared/")) {
      try {
        const readList = async (key) => {
          const raw = await env.CE_SOIR_KV.get(key);
          return raw ? JSON.parse(raw) : [];
        };
        const writeList = async (key, list) => env.CE_SOIR_KV.put(key, JSON.stringify(list));

        if (url.pathname === "/shared/state" && request.method === "GET") {
          const [seen, favorites, likes, dislikes] = await Promise.all([
            readList("seen"), readList("favorites"), readList("likes"), readList("dislikes"),
          ]);
          return new Response(JSON.stringify({ seen, favorites, likes, dislikes }), { headers: jsonHeaders });
        }

        // Listes d'objets (titre/poster/genres) partagées : seen (déjà vu), favorites (sélection),
        // likes (j'aime), dislikes (j'aime pas). Même schéma d'endpoints <nom>-add / <nom>-remove
        // pour les 4 — "seen" stockait auparavant juste des clés (string) ; les anciennes entrées
        // de ce format sont tolérées en lecture (readList ne les modifie pas, le front les affiche
        // en dégradé faute de titre/affiche).
        const itemLists = { seen: "seen", favorite: "favorites", like: "likes", dislike: "dislikes" };
        for (const [prefix, storeKey] of Object.entries(itemLists)) {
          if (url.pathname === `/shared/${prefix}-add` && request.method === "POST") {
            const { item, by } = await request.json();
            const list = await readList(storeKey);
            const key = item?.key || (typeof item === "string" ? item : null);
            const exists = list.some((f) => (typeof f === "string" ? f : f.key) === key);
            if (key && !exists) list.unshift(item);
            await writeList(storeKey, list.slice(0, 300));
            // Notif push : uniquement pour la sélection foyer, et seulement si l'entrée est
            // vraiment nouvelle (on ne veut pas notifier un doublon) et que l'auteur est connu.
            if (prefix === "favorite" && key && !exists && by && KNOWN_EMAILS.includes(by)) {
              const name = DISPLAY_NAMES[by] || "Quelqu'un";
              ctx.waitUntil(notifyOthers(env, by, {
                title: "Sélection du foyer",
                body: `${name} a ajouté ${item.title || "un titre"} 🏠`,
                icon: "./icon-192.png",
                url: "./",
              }));
            }
            return new Response(JSON.stringify({ [storeKey]: list }), { headers: jsonHeaders });
          }
          if (url.pathname === `/shared/${prefix}-remove` && request.method === "POST") {
            const { key } = await request.json();
            const list = (await readList(storeKey)).filter((f) => (typeof f === "string" ? f : f.key) !== key);
            await writeList(storeKey, list);
            return new Response(JSON.stringify({ [storeKey]: list }), { headers: jsonHeaders });
          }
        }

        if (url.pathname === "/shared/reset" && request.method === "POST") {
          await Promise.all([writeList("seen", []), writeList("favorites", []), writeList("likes", []), writeList("dislikes", [])]);
          return new Response(JSON.stringify({ seen: [], favorites: [], likes: [], dislikes: [] }), { headers: jsonHeaders });
        }

        // Abonnements push (un par email connu) + ping de présence pour le rappel programmé du
        // soir (voir scheduled() plus bas), qui évite de notifier quelqu'un qui a déjà ouvert
        // l'app récemment.
        if (url.pathname === "/shared/push-subscribe" && request.method === "POST") {
          const { email, subscription } = await request.json();
          if (!KNOWN_EMAILS.includes(email) || !subscription?.endpoint) {
            return new Response(JSON.stringify({ error: "Requête invalide" }), { status: 400, headers: jsonHeaders });
          }
          await env.CE_SOIR_KV.put(`push-sub:${email}`, JSON.stringify(subscription));
          return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
        }
        if (url.pathname === "/shared/push-unsubscribe" && request.method === "POST") {
          const { email } = await request.json();
          if (KNOWN_EMAILS.includes(email)) await env.CE_SOIR_KV.delete(`push-sub:${email}`);
          return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
        }
        if (url.pathname === "/shared/ping" && request.method === "POST") {
          const { email } = await request.json();
          if (KNOWN_EMAILS.includes(email)) await env.CE_SOIR_KV.put(`last-seen:${email}`, String(Date.now()));
          return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
        }

        return new Response("Route inconnue", { status: 404 });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Erreur état partagé", detail: String(err) }), { status: 500, headers: jsonHeaders });
      }
    }

    // Proxy TMDB : /tmdb/<n'importe quel chemin TMDB> -> https://api.themoviedb.org/3/<chemin>
    // La clé TMDB (env.TMDB_API_KEY) est injectée ici, jamais exposée au navigateur.
    if (url.pathname.startsWith("/tmdb/")) {
      if (request.method !== "GET") {
        return new Response("Méthode non autorisée", { status: 405 });
      }
      try {
        const tmdbPath = url.pathname.slice("/tmdb".length); // ex: /discover/movie
        const tmdbUrl = new URL("https://api.themoviedb.org/3" + tmdbPath);
        url.searchParams.forEach((v, k) => tmdbUrl.searchParams.set(k, v));
        tmdbUrl.searchParams.set("api_key", env.TMDB_API_KEY);

        // Cache à l'edge Cloudflare (partagé entre les 2 comptes du foyer, par datacenter) : la clé
        // de cache exclut la clé API TMDB pour ne jamais la persister dans un cache. On sert le
        // cache s'il existe, sinon on interroge TMDB et on met en cache en arrière-plan (waitUntil)
        // pour ne pas ralentir la réponse envoyée au navigateur.
        const cache = caches.default;
        const cacheKeyUrl = new URL(tmdbUrl.toString());
        cacheKeyUrl.searchParams.delete("api_key");
        const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });

        const cached = await cache.match(cacheKey);
        if (cached) {
          const res = new Response(cached.body, cached);
          res.headers.set("Access-Control-Allow-Origin", "*");
          res.headers.set("X-Cache", "HIT");
          return res;
        }

        const tmdbRes = await fetch(tmdbUrl.toString());
        const data = await tmdbRes.text();
        const maxAge = tmdbCacheTtl(tmdbPath);

        const res = new Response(data, {
          status: tmdbRes.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": `public, max-age=${maxAge}`,
            "X-Cache": "MISS",
          },
        });

        if (tmdbRes.ok && maxAge > 0) ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (err) {
        return new Response(JSON.stringify({ error: "Erreur proxy TMDB", detail: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // Proxy Anthropic (recherche en langage naturel) : POST uniquement, sur toute autre route.
    if (request.method !== "POST") {
      return new Response("Méthode non autorisée", { status: 405 });
    }

    try {
      const body = await request.json();

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY, // clé secrète, jamais exposée au navigateur
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const data = await anthropicRes.text();

      return new Response(data, {
        status: anthropicRes.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Erreur proxy", detail: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },

  // Cron Trigger (voir wrangler.toml) : rappel programmé du soir. On saute les personnes qui
  // ont déjà ouvert l'app dans les 3 dernières heures (déjà engagées ce soir, pas besoin de
  // les relancer) — voir /shared/ping, appelé une fois par le frontend à chaque ouverture.
  async scheduled(event, env, ctx) {
    const SKIP_IF_SEEN_WITHIN_MS = 3 * 60 * 60 * 1000;
    for (const email of KNOWN_EMAILS) {
      const subRaw = await env.CE_SOIR_KV.get(`push-sub:${email}`);
      if (!subRaw) continue;
      const lastSeen = Number(await env.CE_SOIR_KV.get(`last-seen:${email}`)) || 0;
      if (Date.now() - lastSeen < SKIP_IF_SEEN_WITHIN_MS) continue;
      try {
        const status = await sendWebPush(JSON.parse(subRaw), {
          title: "Quoi regarder ce soir ?",
          body: "Une petite session ciné ou série ce soir ? 🍿",
          icon: "./icon-192.png",
          url: "./",
        }, env);
        if (status === 404 || status === 410) await env.CE_SOIR_KV.delete(`push-sub:${email}`);
      } catch (err) { /* on ne bloque jamais le cron pour une seule notif ratée */ }
    }
  },
};
