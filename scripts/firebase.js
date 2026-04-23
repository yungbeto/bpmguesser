//firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-analytics.js";
import { getFirestore, collection, addDoc, query, orderBy, limit, where, getDocs } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/** Set only after the user opts in to analytics (see main.js cookie consent). */
let analytics = null;

/**
 * Call after consent for measurement. Safe to call multiple times; no-ops if already
 * inited or if measurementId is missing.
 */
export function initFirebaseAnalytics() {
  if (analytics) return analytics;
  if (!firebaseConfig.measurementId) return null;
  try {
    analytics = getAnalytics(app);
  } catch {
    return null;
  }
  return analytics;
}

/** How many top scores to load and to use for "qualifies for leaderboard" checks */
export const LEADERBOARD_TOP_N = 50;

export async function getHighScores() {
    const highScoresQuery = query(collection(db, "highScores"), orderBy("score", "desc"), limit(LEADERBOARD_TOP_N));
    return await getDocs(highScoresQuery);
}

export async function addHighScore(name, score, url) {
    return await addDoc(collection(db, "highScores"), {
        name: name,
        score: score,
        url: url,
        timestamp: new Date()
    });
}

/** Shape compatible with the indexed QuerySnapshot; used if the composite index is not deployed yet. */
function dailyScoresFallbackSnapshot(sortedDocs) {
    return {
        docs: sortedDocs,
        get size() {
            return sortedDocs.length;
        },
        get empty() {
            return sortedDocs.length === 0;
        }
    };
}

/**
 * Top-N daily scores for a day. Prefer a single indexed query (fast); if the
 * composite index is missing, fall back to loading all rows for the day
 * (can hang on very busy days — add the index in Firebase, see firestore.indexes.json).
 */
export async function getDailyHighScores(dayNumber) {
    const col = collection(db, "dailyHighScores");
    try {
        const indexed = query(
            col,
            where("dayNumber", "==", dayNumber),
            orderBy("score", "desc"),
            limit(LEADERBOARD_TOP_N)
        );
        return await getDocs(indexed);
    } catch (e) {
        if (e && e.code === "failed-precondition") {
            const unbounded = query(col, where("dayNumber", "==", dayNumber));
            const snap = await getDocs(unbounded);
            const sorted = [...snap.docs]
                .sort((a, b) => (b.data().score || 0) - (a.data().score || 0))
                .slice(0, LEADERBOARD_TOP_N);
            return dailyScoresFallbackSnapshot(sorted);
        }
        throw e;
    }
}

export async function addDailyHighScore(name, score, url, dayNumber) {
    return await addDoc(collection(db, "dailyHighScores"), {
        name, score, url, dayNumber, timestamp: new Date()
    });
}

export { analytics };
