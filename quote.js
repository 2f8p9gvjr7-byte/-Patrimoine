// Fonction serveur Vercel : récupère le cours d'un titre.
// Essaie plusieurs sources dans l'ordre, s'arrête à la première qui répond.
//   /api/quote?symbol=AKE.PA
//   /api/quote?search=Arkema
//   /api/quote?symbol=AKE.PA&debug=1   -> détail de ce que chaque source a répondu

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' };

// Convertit un symbole style Yahoo (AKE.PA) vers le style Stooq (ake.fr)
function toStooq(symbol) {
  const s = symbol.trim().toLowerCase();
  // Paires de devises façon Yahoo : "USDEUR=X" -> "usdeur"
  const fx = s.match(/^([a-z]{6})=x$/);
  if (fx) return fx[1];
  const map = {
    '.pa': '.fr', '.as': '.nl', '.br': '.be', '.de': '.de', '.f': '.de',
    '.mi': '.it', '.mc': '.es', '.l': '.uk', '.sw': '.ch', '.vi': '.at',
    '.st': '.se', '.ol': '.no', '.co': '.dk', '.he': '.fi', '.ls': '.pt'
  };
  for (const [yahoo, stooq] of Object.entries(map)) {
    if (s.endsWith(yahoo)) return s.slice(0, -yahoo.length) + stooq;
  }
  return s.includes('.') ? s : s + '.us'; // sans suffixe = action américaine
}

// --- Source 1 : Yahoo Finance (query2) ---
async function fromYahoo(symbol, diag) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  try {
    const r = await fetch(url, { headers: HEADERS });
    diag.yahoo = 'HTTP ' + r.status;
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (typeof meta?.regularMarketPrice !== 'number') { diag.yahoo += ' (pas de prix)'; return null; }
    return {
      price: meta.regularMarketPrice,
      currency: meta.currency || 'EUR',
      date: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      source: 'Yahoo'
    };
  } catch (e) { diag.yahoo = 'erreur: ' + e.message; return null; }
}

// --- Source 2 : Stooq (fichier CSV) ---
async function fromStooq(symbol, diag) {
  const s = toStooq(symbol);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlc&h&e=csv`;
  try {
    const r = await fetch(url, { headers: HEADERS });
    diag.stooq = `HTTP ${r.status} (${s})`;
    if (!r.ok) return null;
    const csv = (await r.text()).trim();
    const lines = csv.split('\n');
    if (lines.length < 2) { diag.stooq += ' (vide)'; return null; }
    const cols = lines[0].split(',').map(c => c.trim().toLowerCase());
    const vals = lines[1].split(',').map(c => c.trim());
    const get = (name) => vals[cols.indexOf(name)];
    const price = parseFloat(get('close'));
    if (isNaN(price)) { diag.stooq += ' (pas de prix: ' + lines[1] + ')'; return null; }
    const d = get('date'), t = get('time');
    const iso = d && d !== 'N/D' ? new Date(`${d}T${(t && t !== 'N/D') ? t : '00:00:00'}`).toISOString() : new Date().toISOString();
    return { price, currency: 'EUR', date: iso, source: 'Stooq' };
  } catch (e) { diag.stooq = 'erreur: ' + e.message; return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60');

  const { symbol, search, debug } = req.query;
  const diag = {};

  try {
    // --- Recherche d'un symbole à partir d'un nom ---
    if (search) {
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(search)}&quotesCount=10&newsCount=0`;
      const r = await fetch(url, { headers: HEADERS });
      diag.search = 'HTTP ' + r.status;
      if (r.ok) {
        const data = await r.json();
        const quotes = (data.quotes || []).filter(q => q.symbol);
        const euro = ['.PA', '.AS', '.BR', '.DE', '.MI', '.MC', '.L', '.LS'];
        const eq = q => q.quoteType === 'EQUITY';
        const best =
          quotes.find(q => eq(q) && q.symbol.endsWith('.PA')) ||
          quotes.find(q => eq(q) && euro.some(s => q.symbol.endsWith(s))) ||
          quotes.find(eq) || quotes[0];
        if (best) {
          return res.status(200).json({
            ok: true, symbol: best.symbol,
            name: best.shortname || best.longname || '',
            ...(debug ? { diag } : {})
          });
        }
      }
      return res.status(200).json({ ok: false, error: 'search_failed', ...(debug ? { diag } : {}) });
    }

    // --- Cours : on essaie chaque source jusqu'à ce qu'une réponde ---
    if (symbol) {
      for (const source of [fromYahoo, fromStooq]) {
        const result = await source(symbol, diag);
        if (result) {
          return res.status(200).json({ ok: true, symbol, ...result, ...(debug ? { diag } : {}) });
        }
      }
      return res.status(200).json({ ok: false, error: 'aucune_source', diag });
    }

    return res.status(200).json({ ok: false, error: 'missing_param' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'exception', message: e.message, diag });
  }
}
