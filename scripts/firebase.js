// firebase.js
// Firebase is loaded lazily (dynamic import) so it never blocks first paint or UI wiring.
// Firestore Lite is used: we only need one-shot reads and writes, not realtime listeners.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

/** How many top scores to load and to use for "qualifies for leaderboard" checks */
export const LEADERBOARD_TOP_N = 50;

/** Leaderboard reads are cached briefly so one game doesn't refetch the same list 3×. */
const CACHE_TTL_MS = 60_000;

let appPromise = null;
function getApp() {
  appPromise ??= import('firebase/app').then(({ initializeApp }) =>
    initializeApp(firebaseConfig),
  );
  return appPromise;
}

let firestorePromise = null;
function getFirestoreLite() {
  firestorePromise ??= Promise.all([
    getApp(),
    import('firebase/firestore/lite'),
  ]).then(([app, fs]) => ({ fs, db: fs.getFirestore(app) }));
  return firestorePromise;
}

let analyticsPromise = null;
/**
 * Call only after consent for measurement. Safe to call multiple times; no-ops if
 * measurementId is missing or analytics is unsupported in this browser.
 */
export function initFirebaseAnalytics() {
  if (!firebaseConfig.measurementId) return Promise.resolve(null);
  analyticsPromise ??= Promise.all([getApp(), import('firebase/analytics')])
    .then(async ([app, { getAnalytics, isSupported }]) =>
      (await isSupported()) ? getAnalytics(app) : null,
    )
    .catch(() => null);
  return analyticsPromise;
}

/** Plain, render-ready leaderboard entry. Never trust these fields as HTML. */
function toEntry(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    name: typeof d.name === 'string' ? d.name : '',
    score: Number.isFinite(d.score) ? d.score : 0,
    url: typeof d.url === 'string' ? d.url : '',
  };
}

const cache = new Map(); // key -> { at, promise }

function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = loader().catch((err) => {
    cache.delete(key); // don't cache failures
    throw err;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Start the Firebase download early (e.g. on idle) without issuing any reads. */
export function warmUpFirebase() {
  void getFirestoreLite().catch(() => {});
}

/** @returns {Promise<Array<{id,name,score,url}>>} sorted high → low */
export function getHighScores() {
  return cached('alltime', async () => {
    const { fs, db } = await getFirestoreLite();
    const q = fs.query(
      fs.collection(db, 'highScores'),
      fs.orderBy('score', 'desc'),
      fs.limit(LEADERBOARD_TOP_N),
    );
    return (await fs.getDocs(q)).docs.map(toEntry);
  });
}

/**
 * Top-N daily scores for a day. Prefer a single indexed query (fast); if the
 * composite index is missing, fall back to loading all rows for the day
 * (can be slow on busy days — deploy firestore.indexes.json).
 */
export function getDailyHighScores(dayNumber) {
  return cached(`daily:${dayNumber}`, async () => {
    const { fs, db } = await getFirestoreLite();
    const col = fs.collection(db, 'dailyHighScores');
    try {
      const q = fs.query(
        col,
        fs.where('dayNumber', '==', dayNumber),
        fs.orderBy('score', 'desc'),
        fs.limit(LEADERBOARD_TOP_N),
      );
      return (await fs.getDocs(q)).docs.map(toEntry);
    } catch (e) {
      if (e?.code !== 'failed-precondition') throw e;
      const snap = await fs.getDocs(fs.query(col, fs.where('dayNumber', '==', dayNumber)));
      return snap.docs
        .map(toEntry)
        .sort((a, b) => b.score - a.score)
        .slice(0, LEADERBOARD_TOP_N);
    }
  });
}

export async function addHighScore(name, score, url) {
  const { fs, db } = await getFirestoreLite();
  await fs.addDoc(fs.collection(db, 'highScores'), {
    name,
    score,
    url,
    timestamp: fs.serverTimestamp(),
  });
  cache.delete('alltime');
}

export async function addDailyHighScore(name, score, url, dayNumber) {
  const { fs, db } = await getFirestoreLite();
  await fs.addDoc(fs.collection(db, 'dailyHighScores'), {
    name,
    score,
    url,
    dayNumber,
    timestamp: fs.serverTimestamp(),
  });
  cache.delete(`daily:${dayNumber}`);
}
