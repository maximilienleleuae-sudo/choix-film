// Génère flux/iptv-catalog.json à partir du catalogue VOD/séries de ton fournisseur IPTV.
//
// Pourquoi un script à lancer soi-même plutôt qu'un appel direct depuis l'app : l'API du
// fournisseur bloque les requêtes venant de Cloudflare Workers (testé et confirmé — erreur 421
// systématique, y compris avec plusieurs contournements), mais fonctionne normalement depuis une
// connexion "grand public" comme la tienne. Le compromis : le catalogue n'est à jour qu'au moment
// où tu relances ce script, pas en temps réel.
//
// Usage :
//   1. Crée un fichier iptv-credentials.local.json à la racine du projet (jamais commit, voir
//      .gitignore) avec ce contenu, adapté à ton compte :
//      {
//        "server": "http://pr-tv.online:8080",
//        "username": "TON_IDENTIFIANT",
//        "password": "TON_MOT_DE_PASSE"
//      }
//   2. node scripts/iptv-sync.js
//   3. git add flux/iptv-catalog.json && git commit -m "Maj catalogue IPTV" && git push
//
// Nécessite Node 18+ (fetch natif).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CREDENTIALS_FILE = path.join(ROOT, "iptv-credentials.local.json");
const OUTPUT_FILE = path.join(ROOT, "flux", "iptv-catalog.json");

async function fetchAction(authUrl, action) {
  const res = await fetch(`${authUrl}&action=${action}`, {
    headers: { "User-Agent": "IPTVSmarters" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur action=${action}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Réponse inattendue pour action=${action} (identifiants corrects ?)`);
  return data;
}

async function main() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error(
      `Fichier manquant : ${CREDENTIALS_FILE}\n` +
      `Crée-le avec ce contenu (remplace par tes vraies infos) :\n` +
      `{\n  "server": "http://pr-tv.online:8080",\n  "username": "TON_IDENTIFIANT",\n  "password": "TON_MOT_DE_PASSE"\n}`
    );
    process.exit(1);
  }

  const { server, username, password } = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  if (!server || !username || !password) {
    console.error("iptv-credentials.local.json incomplet (server / username / password requis).");
    process.exit(1);
  }
  const base = server.replace(/\/+$/, "");
  const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  console.log("Connexion au serveur IPTV...");
  const [vod, series] = await Promise.all([
    fetchAction(authUrl, "get_vod_streams"),
    fetchAction(authUrl, "get_series").catch((err) => {
      console.warn(`Séries non récupérées (${err.message}) — le catalogue films sera quand même généré.`);
      return [];
    }),
  ]);

  // On ne garde que le strict nécessaire au rapprochement de titre côté app : nom affiché + id.
  // Le reste (icônes, catégories, etc.) ne sert à rien ici et alourdirait le fichier pour rien.
  const catalog = {
    updated: new Date().toISOString().slice(0, 10),
    movies: vod.map((v) => ({ name: v.name, stream_id: v.stream_id })).filter((v) => v.name),
    series: series.map((s) => ({ name: s.name, series_id: s.series_id })).filter((s) => s.name),
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog));

  console.log(`OK : ${catalog.movies.length} films, ${catalog.series.length} séries -> ${path.relative(ROOT, OUTPUT_FILE)}`);
  console.log('Publie avec : git add flux/iptv-catalog.json && git commit -m "Maj catalogue IPTV" && git push');
}

main().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
