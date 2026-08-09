export default {
  async fetch(request, env) {
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
            const { item } = await request.json();
            const list = await readList(storeKey);
            const key = item?.key || (typeof item === "string" ? item : null);
            const exists = list.some((f) => (typeof f === "string" ? f : f.key) === key);
            if (key && !exists) list.unshift(item);
            await writeList(storeKey, list.slice(0, 300));
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

        const tmdbRes = await fetch(tmdbUrl.toString());
        const data = await tmdbRes.text();

        return new Response(data, {
          status: tmdbRes.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
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
};
