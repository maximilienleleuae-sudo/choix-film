import React, { useState, useEffect, useCallback, useRef } from "react";
import { Settings, Sparkles, Heart, X, Play, Upload, ChevronUp, ChevronDown, Star, Shuffle, Loader2, Film, Tv, Trash2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const C = {
  bg: "#10121A",
  bgCard: "#1B1E2B",
  bgCardAlt: "#20243350",
  amber: "#E8A33D",
  amberDim: "#B87F2C",
  teal: "#4A8B8F",
  ink: "#F1ECE1",
  inkMuted: "#8B8A99",
  danger: "#C1502E",
  border: "#2E3244",
};

const MOVIE_GENRE_NAMES_FR = [
  "Action", "Aventure", "Animation", "Comédie", "Crime", "Documentaire", "Drame",
  "Familial", "Fantastique", "Histoire", "Horreur", "Musique", "Mystère", "Romance",
  "Science-Fiction", "Téléfilm", "Thriller", "Guerre", "Western",
];

const FALLBACK_POSTER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='600'><rect width='400' height='600' fill='#1B1E2B'/><text x='200' y='300' fill='#8B8A99' font-family='sans-serif' font-size='20' text-anchor='middle'>Pas d'affiche</text></svg>`
  );

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function useInjectFonts() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);
}

async function safeJson(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function yearOf(item) {
  const d = item.release_date || item.first_air_date;
  return d ? d.slice(0, 4) : "—";
}

function titleOf(item) {
  return item.title || item.name || "Sans titre";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function CeSoir() {
  useInjectFonts();

  const [booted, setBooted] = useState(false);
  const [tmdbKey, setTmdbKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [genreMap, setGenreMap] = useState({}); // name(lowercase) -> {movie:id, tv:id}
  const [genresLoaded, setGenresLoaded] = useState(false);

  const [tasteProfile, setTasteProfile] = useState(null); // {genreIds:[], names:[], sampleCount}
  const [csvStatus, setCsvStatus] = useState("");
  const [csvLoading, setCsvLoading] = useState(false);

  const [moodInput, setMoodInput] = useState("");
  const [moodLoading, setMoodLoading] = useState(false);
  const [moodError, setMoodError] = useState("");

  const [mediaType, setMediaType] = useState("movie"); // movie | tv
  const [activeGenreIds, setActiveGenreIds] = useState([]);
  const [minRating, setMinRating] = useState(0);
  const [sortBy, setSortBy] = useState("popularity.desc");

  const [results, setResults] = useState([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);

  const [seenIds, setSeenIds] = useState(new Set());
  const [favorites, setFavorites] = useState([]);
  const [favDrawerOpen, setFavDrawerOpen] = useState(false);

  const [trailerOpenFor, setTrailerOpenFor] = useState(null);
  const [trailerUrl, setTrailerUrl] = useState("");
  const [trailerLoading, setTrailerLoading] = useState(false);

  const [toast, setToast] = useState("");
  const dragState = useRef({ dragging: false, startX: 0, dx: 0 });
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);

  // -------------------------------------------------------------------------
  // Boot: load persisted state
  // -------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const key = await window.storage.get("tmdb-api-key");
        if (key?.value) setTmdbKey(key.value);
      } catch {}
      try {
        const tp = await window.storage.get("taste-profile");
        if (tp?.value) setTasteProfile(JSON.parse(tp.value));
      } catch {}
      try {
        const seen = await window.storage.get("seen-ids");
        if (seen?.value) setSeenIds(new Set(JSON.parse(seen.value)));
      } catch {}
      try {
        const favs = await window.storage.get("favorites");
        if (favs?.value) setFavorites(JSON.parse(favs.value));
      } catch {}
      setBooted(true);
    })();
  }, []);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }

  // -------------------------------------------------------------------------
  // TMDB key + genres
  // -------------------------------------------------------------------------
  async function saveKey() {
    const k = keyDraft.trim();
    if (!k) return;
    setTmdbKey(k);
    setKeyDraft("");
    try {
      await window.storage.set("tmdb-api-key", k);
    } catch {}
    showToast("Clé TMDB enregistrée");
  }

  const loadGenres = useCallback(async (key) => {
    if (!key) return;
    try {
      const [gm, gt] = await Promise.all([
        fetch(`https://api.themoviedb.org/3/genre/movie/list?api_key=${key}&language=fr-FR`).then(safeJson),
        fetch(`https://api.themoviedb.org/3/genre/tv/list?api_key=${key}&language=fr-FR`).then(safeJson),
      ]);
      const map = {};
      gm.genres?.forEach((g) => {
        map[g.name.toLowerCase()] = { ...(map[g.name.toLowerCase()] || {}), movie: g.id };
      });
      gt.genres?.forEach((g) => {
        map[g.name.toLowerCase()] = { ...(map[g.name.toLowerCase()] || {}), tv: g.id };
      });
      setGenreMap(map);
      setGenresLoaded(true);
    } catch (e) {
      setGenresLoaded(false);
    }
  }, []);

  useEffect(() => {
    if (tmdbKey) loadGenres(tmdbKey);
  }, [tmdbKey, loadGenres]);

  // -------------------------------------------------------------------------
  // CSV import (Netflix export) -> taste profile
  // -------------------------------------------------------------------------
  function handleCsvFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!tmdbKey) {
      showToast("Ajoute d'abord ta clé TMDB");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = String(ev.target.result || "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      // Netflix export: header "Title,Date" — be tolerant of column order/case
      const header = lines[0]?.toLowerCase().split(",") || [];
      let titleIdx = header.findIndex((h) => h.includes("title"));
      if (titleIdx === -1) titleIdx = 0;
      const rawTitles = lines.slice(1).map((line) => {
        // naive CSV split respecting simple quoted fields
        const cells = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
        const t = (cells[titleIdx] || "").replace(/^"|"$/g, "").trim();
        return t.split(":")[0].trim(); // strip episode suffixes "Show: Season X: Ep"
      }).filter(Boolean);

      const unique = [...new Set(rawTitles)];
      const sample = unique.slice(0, 40);
      setCsvLoading(true);
      setCsvStatus(`Analyse de ${sample.length} titres sur ${unique.length}…`);

      const genreCount = {};
      let matched = 0;
      for (const t of sample) {
        try {
          const r = await fetch(
            `https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&language=fr-FR&query=${encodeURIComponent(t)}`
          ).then(safeJson);
          const hit = r.results?.find((x) => x.media_type === "movie" || x.media_type === "tv");
          if (hit) {
            matched++;
            (hit.genre_ids || []).forEach((g) => (genreCount[g] = (genreCount[g] || 0) + 1));
          }
        } catch {}
      }
      const topIds = Object.entries(genreCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id]) => Number(id));

      const names = Object.entries(genreMap)
        .filter(([, ids]) => topIds.includes(ids.movie) || topIds.includes(ids.tv))
        .map(([name]) => name);

      const profile = { genreIds: topIds, names, sampleCount: matched, total: unique.length };
      setTasteProfile(profile);
      try {
        await window.storage.set("taste-profile", JSON.stringify(profile));
      } catch {}
      setCsvLoading(false);
      setCsvStatus(
        `${matched} titres reconnus sur ${sample.length} · goûts dominants : ${names.slice(0, 4).join(", ") || "non déterminés"}`
      );
    };
    reader.readAsText(file);
  }

  // -------------------------------------------------------------------------
  // TMDB discover
  // -------------------------------------------------------------------------
  const runDiscover = useCallback(
    async ({ type = mediaType, genreIds = activeGenreIds, minVote = minRating, sort = sortBy, castIds = [], yearFrom, yearTo, page = 1, keywordText = "" } = {}) => {
      if (!tmdbKey) {
        setSettingsOpen(true);
        showToast("Ajoute ta clé TMDB pour lancer une recherche");
        return;
      }
      setResultsLoading(true);
      setResultsError("");
      try {
        const params = new URLSearchParams({
          api_key: tmdbKey,
          language: "fr-FR",
          sort_by: sort,
          "vote_count.gte": "30",
          page: String(page),
        });
        if (genreIds.length) params.set("with_genres", genreIds.join(","));
        if (minVote) params.set("vote_average.gte", String(minVote));
        if (castIds.length) params.set("with_cast", castIds.join(","));
        if (keywordText) params.set("with_keywords", keywordText);
        const dateField = type === "movie" ? "primary_release_date" : "first_air_date";
        if (yearFrom) params.set(`${dateField}.gte`, `${yearFrom}-01-01`);
        if (yearTo) params.set(`${dateField}.lte`, `${yearTo}-12-31`);

        const url = `https://api.themoviedb.org/3/discover/${type === "movie" ? "movie" : "tv"}?${params.toString()}`;
        const data = await fetch(url).then(safeJson);
        const items = (data.results || [])
          .map((it) => ({ ...it, media_type: type }))
          .filter((it) => !seenIds.has(`${type}-${it.id}`));
        setResults(items);
        setCurrentIndex(0);
        if (!items.length) setResultsError("Aucun résultat pour ces critères — élargis un peu les filtres.");
      } catch (e) {
        setResultsError("Impossible de charger les suggestions (clé TMDB invalide ou hors-ligne ?).");
      }
      setResultsLoading(false);
    },
    [tmdbKey, mediaType, activeGenreIds, minRating, sortBy, seenIds]
  );

  // -------------------------------------------------------------------------
  // Mood prompt -> Claude API -> filters -> discover
  // -------------------------------------------------------------------------
  async function runMoodSearch() {
    const prompt = moodInput.trim();
    if (!prompt) return;
    if (!tmdbKey) {
      setSettingsOpen(true);
      showToast("Ajoute ta clé TMDB pour lancer une recherche");
      return;
    }
    setMoodLoading(true);
    setMoodError("");
    try {
      const system = `Tu transformes une envie exprimée en langage naturel (en français) en critères de recherche TMDB.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, au format exact :
{"type":"movie"|"tv","genres":[string],"year_from":number|null,"year_to":number|null,"cast_names":[string],"min_rating":number|null,"sort":"popularity.desc"|"vote_average.desc"|"primary_release_date.desc"}
Les genres doivent venir uniquement de cette liste : ${MOVIE_GENRE_NAMES_FR.join(", ")}.
"récent" veut dire année de début = ${new Date().getFullYear() - 3}. "type" vaut "tv" si l'utilisateur mentionne une série, sinon "movie".`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(text);

      const genreIds = (parsed.genres || [])
        .map((n) => genreMap[n.toLowerCase()]?.[parsed.type === "tv" ? "tv" : "movie"])
        .filter(Boolean);

      let castIds = [];
      if (parsed.cast_names?.length) {
        const found = await Promise.all(
          parsed.cast_names.slice(0, 3).map((name) =>
            fetch(`https://api.themoviedb.org/3/search/person?api_key=${tmdbKey}&query=${encodeURIComponent(name)}`)
              .then(safeJson)
              .then((r) => r.results?.[0]?.id)
              .catch(() => null)
          )
        );
        castIds = found.filter(Boolean);
      }

      const type = parsed.type === "tv" ? "tv" : "movie";
      setMediaType(type);
      setActiveGenreIds(genreIds);
      setMinRating(parsed.min_rating || 0);
      setSortBy(parsed.sort || "popularity.desc");

      await runDiscover({
        type,
        genreIds,
        minVote: parsed.min_rating || 0,
        sort: parsed.sort || "popularity.desc",
        castIds,
        yearFrom: parsed.year_from,
        yearTo: parsed.year_to,
      });
    } catch (e) {
      setMoodError("Je n'ai pas réussi à interpréter cette envie — essaie de reformuler.");
    }
    setMoodLoading(false);
  }

  // -------------------------------------------------------------------------
  // Surprends-moi
  // -------------------------------------------------------------------------
  async function surpriseMe() {
    const genreIds = tasteProfile?.genreIds?.length ? tasteProfile.genreIds : activeGenreIds;
    await runDiscover({
      type: mediaType,
      genreIds,
      minVote: 6.5,
      sort: "popularity.desc",
      page: 1 + Math.floor(Math.random() * 5),
    });
  }

  // -------------------------------------------------------------------------
  // Swipe / decisions
  // -------------------------------------------------------------------------
  async function persistSeen(next) {
    setSeenIds(next);
    try {
      await window.storage.set("seen-ids", JSON.stringify([...next]));
    } catch {}
  }
  async function persistFavorites(next) {
    setFavorites(next);
    try {
      await window.storage.set("favorites", JSON.stringify(next));
    } catch {}
  }

  function advanceCard() {
    setDragX(0);
    setCurrentIndex((i) => i + 1);
    setTrailerOpenFor(null);
  }

  function markSeen(item) {
    const key = `${item.media_type}-${item.id}`;
    const next = new Set(seenIds);
    next.add(key);
    persistSeen(next);
    advanceCard();
  }

  function addFavorite(item) {
    const key = `${item.media_type}-${item.id}`;
    if (favorites.some((f) => f.key === key)) {
      advanceCard();
      return;
    }
    const next = [
      { key, id: item.id, media_type: item.media_type, title: titleOf(item), poster: item.poster_path, year: yearOf(item) },
      ...favorites,
    ].slice(0, 12);
    persistFavorites(next);
    showToast("Ajouté à ta sélection ♥");
    advanceCard();
  }

  function removeFavorite(key) {
    persistFavorites(favorites.filter((f) => f.key !== key));
  }

  // -------------------------------------------------------------------------
  // Trailer
  // -------------------------------------------------------------------------
  async function openTrailer(item) {
    if (trailerOpenFor === item.id) {
      setTrailerOpenFor(null);
      return;
    }
    setTrailerOpenFor(item.id);
    setTrailerLoading(true);
    setTrailerUrl("");
    try {
      const kind = item.media_type === "movie" ? "movie" : "tv";
      let data = await fetch(
        `https://api.themoviedb.org/3/${kind}/${item.id}/videos?api_key=${tmdbKey}&language=fr-FR`
      ).then(safeJson);
      let vid = data.results?.find((v) => v.site === "YouTube" && v.type === "Trailer");
      if (!vid) {
        data = await fetch(`https://api.themoviedb.org/3/${kind}/${item.id}/videos?api_key=${tmdbKey}&language=en-US`).then(safeJson);
        vid = data.results?.find((v) => v.site === "YouTube" && v.type === "Trailer") || data.results?.[0];
      }
      if (vid) setTrailerUrl(`https://www.youtube.com/embed/${vid.key}?autoplay=1`);
    } catch {}
    setTrailerLoading(false);
  }

  // -------------------------------------------------------------------------
  // Drag handlers (pointer events)
  // -------------------------------------------------------------------------
  function onPointerDown(e) {
    dragState.current = { dragging: true, startX: e.clientX, dx: 0 };
    setDragging(true);
  }
  function onPointerMove(e) {
    if (!dragState.current.dragging) return;
    const dx = e.clientX - dragState.current.startX;
    dragState.current.dx = dx;
    setDragX(dx);
  }
  function onPointerUp() {
    if (!dragState.current.dragging) return;
    const dx = dragState.current.dx;
    dragState.current.dragging = false;
    setDragging(false);
    const current = results[currentIndex];
    if (Math.abs(dx) > 110 && current) {
      if (dx > 0) addFavorite(current);
      else markSeen(current);
    } else {
      setDragX(0);
    }
  }

  // -------------------------------------------------------------------------
  // Genre chip toggle (manual filters, re-runs discover)
  // -------------------------------------------------------------------------
  function toggleGenre(name) {
    const id = genreMap[name.toLowerCase()]?.[mediaType];
    if (!id) return;
    const next = activeGenreIds.includes(id) ? activeGenreIds.filter((g) => g !== id) : [...activeGenreIds, id];
    setActiveGenreIds(next);
    runDiscover({ genreIds: next });
  }

  async function resetSeenAndFavorites() {
    await persistSeen(new Set());
    await persistFavorites([]);
    showToast("Historique de choix réinitialisé");
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  const current = results[currentIndex];
  const next2 = results.slice(currentIndex + 1, currentIndex + 3);
  const sortedNote = { "popularity.desc": "Popularité", "vote_average.desc": "Note", "primary_release_date.desc": "Année" };

  if (!booted) {
    return (
      <div style={{ background: C.bg, minHeight: "100vh" }} className="flex items-center justify-center">
        <Loader2 className="animate-spin" color={C.amber} size={28} />
      </div>
    );
  }

  return (
    <div
      style={{ background: C.bg, color: C.ink, fontFamily: "Inter, sans-serif", minHeight: "100vh" }}
      className="w-full flex flex-col relative overflow-hidden"
    >
      <style>{`
        @keyframes sweep { 0% { transform: translateX(-120%) skewX(-15deg); } 100% { transform: translateX(220%) skewX(-15deg); } }
        @media (prefers-reduced-motion: reduce) { .sweep { animation: none !important; } .card-transition { transition: none !important; } }
        .font-display { font-family: 'Fraunces', serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        input:focus, button:focus, textarea:focus { outline: 2px solid ${C.amber}; outline-offset: 2px; }
        .card-transition { transition: transform 0.35s ease, opacity 0.35s ease; }
        .scrollbar-none::-webkit-scrollbar { display: none; }
      `}</style>

      {/* Header */}
      <header className="relative px-5 pt-6 pb-4 flex items-center justify-between overflow-hidden" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="sweep absolute inset-y-0 left-0 w-1/3 pointer-events-none" style={{ background: `linear-gradient(90deg, transparent, ${C.amber}22, transparent)`, animation: "sweep 2.4s ease-out 1" }} />
        <div>
          <p className="font-mono text-xs tracking-widest" style={{ color: C.amberDim }}>SÉANCE DU SOIR</p>
          <h1 className="font-display text-3xl" style={{ color: C.ink }}>Ce soir</h1>
        </div>
        <button onClick={() => setSettingsOpen(true)} aria-label="Réglages" className="p-2 rounded-full" style={{ background: C.bgCard }}>
          <Settings size={20} color={C.inkMuted} />
        </button>
      </header>

      {/* Mood prompt */}
      <div className="px-5 pt-4">
        <div className="flex gap-2">
          <input
            value={moodInput}
            onChange={(e) => setMoodInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runMoodSearch()}
            placeholder="Une comédie française récente avec…"
            className="flex-1 rounded-xl px-4 py-3 text-sm"
            style={{ background: C.bgCard, border: `1px solid ${C.border}`, color: C.ink }}
          />
          <button
            onClick={runMoodSearch}
            disabled={moodLoading}
            className="rounded-xl px-4 flex items-center justify-center"
            style={{ background: C.amber, color: "#1A1305" }}
            aria-label="Chercher"
          >
            {moodLoading ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
          </button>
        </div>
        {moodError && <p className="text-xs mt-2" style={{ color: C.danger }}>{moodError}</p>}
      </div>

      {/* Filters */}
      <div className="px-5 pt-3 flex gap-2 overflow-x-auto scrollbar-none">
        <button
          onClick={() => { const t = mediaType === "movie" ? "tv" : "movie"; setMediaType(t); runDiscover({ type: t }); }}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium flex items-center gap-1.5"
          style={{ background: C.bgCard, border: `1px solid ${C.border}`, color: C.ink }}
        >
          {mediaType === "movie" ? <Film size={13} /> : <Tv size={13} />}
          {mediaType === "movie" ? "Films" : "Séries"}
        </button>
        {["Comédie", "Drame", "Thriller", "Action", "Science-Fiction", "Horreur", "Romance", "Animation"].map((g) => (
          <button
            key={g}
            onClick={() => toggleGenre(g)}
            className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium"
            style={{
              background: activeGenreIds.includes(genreMap[g.toLowerCase()]?.[mediaType]) ? C.amber : C.bgCard,
              color: activeGenreIds.includes(genreMap[g.toLowerCase()]?.[mediaType]) ? "#1A1305" : C.ink,
              border: `1px solid ${C.border}`,
            }}
          >
            {g}
          </button>
        ))}
        <button
          onClick={() => { const v = minRating >= 7 ? 0 : 7; setMinRating(v); runDiscover({ minVote: v }); }}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium flex items-center gap-1"
          style={{ background: minRating >= 7 ? C.amber : C.bgCard, color: minRating >= 7 ? "#1A1305" : C.ink, border: `1px solid ${C.border}` }}
        >
          <Star size={12} /> 7+
        </button>
        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value); runDiscover({ sort: e.target.value }); }}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium"
          style={{ background: C.bgCard, border: `1px solid ${C.border}`, color: C.ink }}
        >
          <option value="popularity.desc">Tri : Popularité</option>
          <option value="vote_average.desc">Tri : Note</option>
          <option value="primary_release_date.desc">Tri : Année</option>
        </select>
      </div>

      {/* Card stack */}
      <main className="flex-1 px-5 py-6 flex flex-col items-center justify-center relative" style={{ minHeight: 460 }}>
        {resultsLoading && <Loader2 className="animate-spin" color={C.amber} size={26} />}

        {!resultsLoading && resultsError && (
          <p className="text-sm text-center px-6" style={{ color: C.inkMuted }}>{resultsError}</p>
        )}

        {!resultsLoading && !results.length && !resultsError && (
          <div className="text-center px-6">
            <p className="font-display text-xl mb-2">Prêt pour la séance ?</p>
            <p className="text-sm" style={{ color: C.inkMuted }}>
              Tape ton envie du moment ci-dessus, choisis un genre, ou laisse-toi surprendre.
            </p>
          </div>
        )}

        {!resultsLoading && current && (
          <div className="relative w-full max-w-sm" style={{ height: 460 }}>
            {next2.map((it, i) => (
              <div
                key={it.id + it.media_type}
                className="absolute inset-0 rounded-2xl"
                style={{
                  background: C.bgCard,
                  transform: `scale(${0.96 - i * 0.04}) translateY(${(i + 1) * 10}px)`,
                  zIndex: 1 - i,
                  border: `1px solid ${C.border}`,
                }}
              />
            ))}

            <div
              className="absolute inset-0 rounded-2xl overflow-hidden card-transition select-none"
              style={{
                zIndex: 5,
                transform: `translateX(${dragX}px) rotate(${dragX / 20}deg)`,
                border: `1px solid ${C.border}`,
                cursor: dragging ? "grabbing" : "grab",
                touchAction: "pan-y",
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <img
                src={current.poster_path ? `https://image.tmdb.org/t/p/w500${current.poster_path}` : FALLBACK_POSTER}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
              />
              <div className="absolute inset-0" style={{ background: "linear-gradient(to top, #10121Af2 5%, #10121A66 45%, transparent 70%)" }} />

              {/* rating badge */}
              <div className="absolute top-3 right-3 rounded-full px-2.5 py-1 flex items-center gap-1 font-mono text-xs" style={{ background: "#10121Ad0", border: `1px solid ${C.amberDim}` }}>
                <Star size={11} color={C.amber} fill={C.amber} />
                <span style={{ color: C.amber }}>{current.vote_average?.toFixed(1) ?? "—"}</span>
              </div>

              {/* swipe hints */}
              {dragX < -40 && <div className="absolute top-6 left-4 rounded-lg px-3 py-1 font-mono text-xs" style={{ background: C.danger, color: "#fff" }}>DÉJÀ VU</div>}
              {dragX > 40 && <div className="absolute top-6 right-4 rounded-lg px-3 py-1 font-mono text-xs" style={{ background: C.amber, color: "#1A1305" }}>SÉLECTION</div>}

              <div className="absolute bottom-0 left-0 right-0 p-4">
                <p className="font-mono text-[11px] tracking-wide mb-1" style={{ color: C.teal }}>
                  {yearOf(current)} · {current.media_type === "movie" ? "FILM" : "SÉRIE"}
                </p>
                <h2 className="font-display text-2xl leading-tight mb-2">{titleOf(current)}</h2>
                <p className="text-sm leading-snug mb-3" style={{ color: C.inkMuted, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {current.overview || "Synopsis non disponible."}
                </p>

                {trailerOpenFor === current.id && (
                  <div className="mb-3 rounded-lg overflow-hidden" style={{ aspectRatio: "16/9", background: "#000" }}>
                    {trailerLoading && <div className="w-full h-full flex items-center justify-center"><Loader2 className="animate-spin" color={C.amber} size={20} /></div>}
                    {!trailerLoading && trailerUrl && <iframe src={trailerUrl} className="w-full h-full" allow="autoplay; encrypted-media" title="Bande-annonce" />}
                    {!trailerLoading && !trailerUrl && <p className="text-xs p-3" style={{ color: C.inkMuted }}>Pas de bande-annonce trouvée.</p>}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button onClick={() => markSeen(current)} className="p-3 rounded-full" style={{ background: "#2A2130", border: `1px solid ${C.border}` }} aria-label="Déjà vu, passer">
                    <X size={18} color={C.danger} />
                  </button>
                  <button onClick={() => openTrailer(current)} className="flex-1 rounded-full py-3 text-sm font-medium flex items-center justify-center gap-2" style={{ background: C.bgCard, border: `1px solid ${C.border}` }}>
                    <Play size={15} color={C.ink} /> Bande-annonce
                  </button>
                  <button onClick={() => addFavorite(current)} className="p-3 rounded-full" style={{ background: "#2A2A18", border: `1px solid ${C.border}` }} aria-label="Ajouter à ma sélection">
                    <Heart size={18} color={C.amber} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!resultsLoading && results.length > 0 && !current && (
          <div className="text-center px-6">
            <p className="font-display text-xl mb-2">Plus rien pour ce soir</p>
            <p className="text-sm" style={{ color: C.inkMuted }}>Lance une nouvelle recherche ou surprends-toi.</p>
          </div>
        )}
      </main>

      {/* Surprends-moi */}
      <button
        onClick={surpriseMe}
        className="fixed left-1/2 rounded-full px-5 py-3 text-sm font-semibold flex items-center gap-2 shadow-lg"
        style={{ bottom: 84, transform: "translateX(-50%)", background: C.amber, color: "#1A1305" }}
      >
        <Shuffle size={16} /> Surprends-moi
      </button>

      {/* Favorites drawer */}
      <div
        className="fixed left-0 right-0 bottom-0 rounded-t-2xl card-transition"
        style={{
          background: C.bgCard,
          borderTop: `1px solid ${C.border}`,
          transform: favDrawerOpen ? "translateY(0)" : "translateY(calc(100% - 52px))",
          maxHeight: "70vh",
        }}
      >
        <button onClick={() => setFavDrawerOpen((o) => !o)} className="w-full flex items-center justify-between px-5 py-3.5">
          <span className="text-sm font-medium">Ma sélection ce soir ({favorites.length})</span>
          {favDrawerOpen ? <ChevronDown size={18} color={C.inkMuted} /> : <ChevronUp size={18} color={C.inkMuted} />}
        </button>
        <div className="px-5 pb-6 overflow-y-auto" style={{ maxHeight: "55vh" }}>
          {favorites.length === 0 && <p className="text-xs pb-3" style={{ color: C.inkMuted }}>Glisse une carte vers la droite (ou ♥) pour la garder ici.</p>}
          {favorites.map((f) => (
            <div key={f.key} className="flex items-center gap-3 py-2" style={{ borderBottom: `1px solid ${C.border}` }}>
              <img src={f.poster ? `https://image.tmdb.org/t/p/w92${f.poster}` : FALLBACK_POSTER} alt="" className="w-10 h-14 object-cover rounded" />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{f.title}</p>
                <p className="font-mono text-[11px]" style={{ color: C.inkMuted }}>{f.year} · {f.media_type === "movie" ? "Film" : "Série"}</p>
              </div>
              <button onClick={() => removeFavorite(f.key)} aria-label="Retirer" className="p-2">
                <Trash2 size={15} color={C.inkMuted} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Settings drawer */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "#000000a0" }} onClick={() => setSettingsOpen(false)}>
          <div className="w-full rounded-t-2xl p-5" style={{ background: C.bgCard, borderTop: `1px solid ${C.border}` }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-xl">Réglages</h3>
              <button onClick={() => setSettingsOpen(false)} aria-label="Fermer"><X size={20} color={C.inkMuted} /></button>
            </div>

            <label className="text-xs font-mono block mb-1.5" style={{ color: C.inkMuted }}>CLÉ API TMDB (gratuite sur themoviedb.org)</label>
            <div className="flex gap-2 mb-1">
              <input
                value={keyDraft || tmdbKey}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="Colle ta clé v3 ici"
                className="flex-1 rounded-lg px-3 py-2.5 text-sm"
                style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.ink }}
              />
              <button onClick={saveKey} className="rounded-lg px-4 text-sm font-medium" style={{ background: C.amber, color: "#1A1305" }}>Enregistrer</button>
            </div>
            {tmdbKey && genresLoaded && <p className="text-xs mb-4" style={{ color: C.teal }}>Clé active ✓</p>}
            {tmdbKey && !genresLoaded && <p className="text-xs mb-4" style={{ color: C.danger }}>Clé invalide ou hors-ligne</p>}
            {!tmdbKey && <p className="text-xs mb-4" style={{ color: C.inkMuted }}>Sans clé, aucune recherche n'est possible.</p>}

            <label className="text-xs font-mono block mb-1.5" style={{ color: C.inkMuted }}>HISTORIQUE NETFLIX (export CSV)</label>
            <label className="flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm mb-1 cursor-pointer" style={{ background: C.bg, border: `1px dashed ${C.border}`, color: C.ink }}>
              <Upload size={16} />
              Importer le fichier CSV
              <input type="file" accept=".csv" className="hidden" onChange={handleCsvFile} />
            </label>
            {csvLoading && <p className="text-xs mb-4 flex items-center gap-1.5" style={{ color: C.inkMuted }}><Loader2 size={12} className="animate-spin" /> {csvStatus}</p>}
            {!csvLoading && csvStatus && <p className="text-xs mb-4" style={{ color: C.teal }}>{csvStatus}</p>}
            {!csvStatus && !csvLoading && tasteProfile && (
              <p className="text-xs mb-4" style={{ color: C.teal }}>Profil déjà chargé · goûts : {tasteProfile.names.slice(0, 4).join(", ") || "—"}</p>
            )}

            <button onClick={resetSeenAndFavorites} className="w-full text-center text-xs py-2.5 rounded-lg" style={{ color: C.danger, border: `1px solid ${C.border}` }}>
              Réinitialiser « déjà vu » et sélection
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 left-1/2 z-50 rounded-full px-4 py-2 text-xs font-medium" style={{ transform: "translateX(-50%)", background: C.bgCard, border: `1px solid ${C.border}`, color: C.ink }}>
          {toast}
        </div>
      )}
    </div>
  );
}
