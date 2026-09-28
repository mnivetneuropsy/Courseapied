/* RunQuest — service worker : hors-ligne + rappels */
const CACHE = 'runquest-v2.3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const DATA_CACHE = 'runquest-data';

/* ============================================================
   Coach : messages de motivation / rappels.
   Fonction PURE partagée par la page et le service worker :
   elle ne lit que le "résumé" que l'appli lui fournit.
   ============================================================ */

function coachPad(n) { return String(n).padStart(2, '0'); }
function coachDateStr(d) { return `${d.getFullYear()}-${coachPad(d.getMonth() + 1)}-${coachPad(d.getDate())}`; }
function coachParse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function coachDaysBetween(a, b) { return Math.round((coachParse(b) - coachParse(a)) / 86400000); }
function coachWeekKey(dateStr) {
  const t = coachParse(dateStr);
  const dayNr = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - dayNr + 3);
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${week}`;
}

const COACH_NUDGES = [
  "Même 20 minutes tranquilles, ça compte.",
  "Tes baskets t'attendent près de la porte.",
  "Une petite sortie, et la semaine repart.",
  "Pas besoin d'aller vite : juste d'y aller.",
  "Le plus dur, c'est de lacer les chaussures.",
];

// summary : voir buildCoachSummary() dans l'appli.
// Retourne une liste de { key, type, title, body } triée par priorité.
function computeCoachMessages(summary, now, opts) {
  opts = opts || {};
  if (!summary || !summary.prefs || (!summary.prefs.enabled && !opts.inApp)) return [];
  const p = summary.prefs;
  const today = coachDateStr(now);
  const hour = now.getHours();
  const out = [];
  if (!opts.inApp && (hour < 9 || hour >= 21)) return out; // jamais de notification la nuit

  const sameWeek = summary.weekKey === coachWeekKey(today);
  const kmWeek = sameWeek ? summary.kmWeek : 0;
  const levels = summary.weeklyLevels || [10, 20, 30, 40, 50];
  const unlockedLevels = sameWeek ? (summary.weeklyUnlockedCount || 0) : 0;
  const daysSince = summary.lastRunDate ? coachDaysBetween(summary.lastRunDate, today) : null;
  const dow = now.getDay(); // 0 = dimanche

  // 1. Série en jeu aujourd'hui
  if ((p.streak || opts.inApp) && summary.currentStreak >= 3 && daysSince === summary.restDays + 1 && (hour >= 16 || opts.inApp)) {
    out.push({
      key: `streak:${today}`, type: 'streak',
      title: `🔥 Ta série de ${summary.currentStreak} jours se joue aujourd'hui`,
      body: "Une sortie avant ce soir et elle continue.",
    });
  }

  // 2. Fin de semaine : badge hebdomadaire à portée
  if ((p.weekEnd || opts.inApp) && (dow === 6 || dow === 0) && unlockedLevels < levels.length) {
    const target = levels[unlockedLevels];
    const remaining = Math.round((target - kmWeek) * 10) / 10;
    if (remaining > 0 && remaining <= 12) {
      out.push({
        key: `weekend:${today}`, type: 'weekEnd',
        title: `🏅 Plus que ${String(remaining).replace('.', ',')} km pour le niveau ${unlockedLevels + 1}`,
        body: dow === 0 ? "Dernier jour de la semaine : le badge se joue aujourd'hui !" : "Il reste le week-end pour décrocher le badge de la semaine.",
      });
    }
  }

  // 3. Checkpoint du défi en vue
  const ch = summary.challenge;
  if ((p.challenge || opts.inApp) && ch && ch.nextCheckpointKm != null) {
    const remaining = Math.round((ch.nextCheckpointKm - ch.currentKm) * 10) / 10;
    if (remaining > 0 && remaining <= 5) {
      out.push({
        key: `challenge:${ch.id}:${ch.nextCheckpointPct}`, type: 'challenge',
        title: `🗺️ ${ch.name} : checkpoint ${ch.nextCheckpointPct} % en vue`,
        body: `Plus que ${String(remaining).replace('.', ',')} km pour l'atteindre.`,
      });
    }
  }

  // 2 bis. Récupéré après une grosse séance
  const rec = summary.recovery;
  if ((p.recovery || opts.inApp) && rec && rec.hours >= 36) {
    const ra = new Date(rec.readyAt);
    if (now >= ra && now - ra < 20 * 3600000) {
      out.push({
        key: `recovered:${rec.runDate}`, type: 'recovery',
        title: "✅ Tu es récupéré !",
        body: "Tes jambes ont eu le temps d'encaisser : prêt pour une belle séance.",
      });
    }
  }

  // 3 bis. Bilan du mois écoulé disponible (les 3 premiers jours du mois)
  if ((p.bilan || opts.inApp) && now.getDate() <= 3 && summary.prevMonthRuns > 0) {
    out.push({
      key: `bilan:${today.slice(0, 7)}`, type: 'bilan',
      title: "🗓️ Ton bilan du mois est prêt",
      body: `${summary.prevMonthRuns} sortie${summary.prevMonthRuns > 1 ? 's' : ''} le mois dernier : viens voir ton récap.`,
    });
  }

  // 4. Inactivité
  if ((p.inactivity || opts.inApp) && summary.runsCount > 0 && daysSince != null && daysSince >= p.inactivityDays) {
    const nudge = COACH_NUDGES[coachParse(today).getDate() % COACH_NUDGES.length];
    out.push({
      key: `inactivity:${today}`, type: 'inactivity',
      title: `👟 Ça fait ${daysSince} jours sans courir`,
      body: nudge,
    });
  }

  // 5. Sauvegarde
  if ((p.backup || opts.inApp) && summary.runsCount >= 5) {
    const since = summary.lastExport ? coachDaysBetween(summary.lastExport, today) : 999;
    if (since >= 30) {
      out.push({
        key: `backup:${coachWeekKey(today)}`, type: 'backup',
        title: "💾 Pense à sauvegarder tes courses",
        body: "Tes données ne sont stockées que sur cet appareil : un export JSON prend 2 secondes.",
      });
    }
  }
  return out;
}

// Filtre selon l'historique d'envoi : max 2 notifications par jour, jamais deux fois la même.
function pickCoachNotifications(messages, log, now) {
  const today = coachDateStr(now);
  const sentToday = Object.values(log || {}).filter(d => d === today).length;
  const budget = Math.max(0, 2 - sentToday);
  return messages.filter(m => !(log && log[m.key])).slice(0, Math.min(1, budget));
}


self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('runquest-v') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('__rq_')) return;
  if (req.mode === 'navigate') {
    // Réseau d'abord pour toujours avoir la dernière version, cache si hors ligne
    event.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then(c => c.put('./index.html', copy));
      return res;
    }).catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }
  event.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    });
    return hit || net;
  }));
});

async function readJson(key, fallback) {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match(new URL(key, self.registration.scope).href);
    return r ? await r.json() : fallback;
  } catch (e) { return fallback; }
}
async function writeJson(key, value) {
  const c = await caches.open(DATA_CACHE);
  await c.put(new URL(key, self.registration.scope).href, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
}

async function coachCheck() {
  const summary = await readJson('./__rq_summary.json', null);
  if (!summary) return;
  const now = new Date();
  const log = await readJson('./__rq_notiflog.json', {});
  const picks = pickCoachNotifications(computeCoachMessages(summary, now), log, now);
  const today = coachDateStr(now);
  for (const m of picks) {
    await self.registration.showNotification(m.title, {
      body: m.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: m.type, data: { url: './' },
    });
    log[m.key] = today;
  }
  // on ne garde que 30 jours d'historique d'envoi
  Object.keys(log).forEach(k => { if (coachDaysBetween(log[k], today) > 30) delete log[k]; });
  await writeJson('./__rq_notiflog.json', log);
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'coach-check') event.waitUntil(coachCheck());
});
self.addEventListener('periodicsync', event => {
  if (event.tag === 'rq-coach') event.waitUntil(coachCheck());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  })());
});
