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
