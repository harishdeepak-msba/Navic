// Firebase wiring for accounts and consent-based friend location sharing.
// Exposes window.NavicAuth for the main app script to call.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut as fbSignOut,
  onAuthStateChanged, sendPasswordResetEmail, updatePassword, deleteUser,
  reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, updateDoc, onSnapshot,
  collection, query, where, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDAAHLRW8mR2W8yfGfHMFb3hHpOTYxS8rs",
  authDomain: "navic-guide-bb8b0.firebaseapp.com",
  projectId: "navic-guide-bb8b0",
  storageBucket: "navic-guide-bb8b0.firebasestorage.app",
  messagingSenderId: "658279583616",
  appId: "1:658279583616:web:bae81ee7d829e2c10f3b65"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const linkId = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
const lower = s => s.trim().toLowerCase();
const validName = s => /^[a-z0-9_]{3,20}$/.test(s);

let stateCb = null;
let linksUnsub = null;
let friendUnsubs = {};
let lastPushAt = 0;
let current = { user: null, username: null, shareLocation: false, friends: [], incoming: [], outgoing: [] };

function emit() { if (stateCb) stateCb({ ...current, friends: [...current.friends], incoming: [...current.incoming], outgoing: [...current.outgoing] }); }

function stopLinks() {
  if (linksUnsub) { linksUnsub(); linksUnsub = null; }
  Object.values(friendUnsubs).forEach(u => u());
  friendUnsubs = {};
  current.friends = []; current.incoming = []; current.outgoing = [];
}

async function loadMyProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  if (snap.exists()) {
    current.username = snap.data().username || null;
    current.shareLocation = !!snap.data().shareLocation;
  } else {
    current.username = null;
    current.shareLocation = false;
  }
}

function watchLinks(uid) {
  stopLinks();
  const q = query(collection(db, 'links'), where('members', 'array-contains', uid));
  linksUnsub = onSnapshot(q, snap => {
    const accepted = [], incoming = [], outgoing = [];
    snap.forEach(d => {
      const v = d.data();
      const other = v.members.find(m => m !== uid);
      const row = { linkId: d.id, uid: other, username: v.usernames ? v.usernames[other] : other };
      if (v.status === 'accepted') accepted.push(row);
      else if (v.status === 'pending' && v.requestedBy === uid) outgoing.push(row);
      else if (v.status === 'pending') incoming.push(row);
    });
    current.incoming = incoming; current.outgoing = outgoing;

    const wantUids = new Set(accepted.map(f => f.uid));
    Object.keys(friendUnsubs).forEach(fu => { if (!wantUids.has(fu)) { friendUnsubs[fu](); delete friendUnsubs[fu]; } });
    current.friends = accepted.map(f => ({ ...f, lat: null, lon: null, sharing: false }));
    emit();
    accepted.forEach(f => {
      if (friendUnsubs[f.uid]) return;
      friendUnsubs[f.uid] = onSnapshot(doc(db, 'users', f.uid), s => {
        console.log('[navic] friend doc update for', f.username, s.exists() ? s.data() : '(missing)');
        const row = current.friends.find(x => x.uid === f.uid);
        if (!row) return;
        if (s.exists() && s.data().shareLocation) {
          row.lat = s.data().lat ?? null; row.lon = s.data().lon ?? null; row.sharing = true;
        } else {
          row.lat = null; row.lon = null; row.sharing = false;
        }
        emit();
      }, e => { /* no access: friend turned sharing off, rule denies read */
        console.log('[navic] friend doc read FAILED for', f.username, e.code || e.message || e);
        const row = current.friends.find(x => x.uid === f.uid);
        if (row) { row.lat = null; row.lon = null; row.sharing = false; emit(); }
      });
    });
  });
}

onAuthStateChanged(auth, async user => {
  current.user = user;
  if (user) {
    await loadMyProfile(user.uid);
    watchLinks(user.uid);
  } else {
    current.username = null; current.shareLocation = false;
    stopLinks();
  }
  emit();
});

async function claimUsername(uid, name) {
  const key = lower(name);
  if (!validName(key)) throw new Error('Use 3 to 20 letters, numbers or underscore.');
  const ref = doc(db, 'usernames', key);
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().uid !== uid) throw new Error('That name is taken.');
  const batch = writeBatch(db);
  if (current.username) {
    const oldRef = doc(db, 'usernames', lower(current.username));
    const oldSnap = await getDoc(oldRef);
    if (oldSnap.exists() && oldSnap.data().uid === uid) batch.delete(oldRef);
  }
  batch.set(ref, { uid });
  batch.set(doc(db, 'users', uid), { username: name.trim(), usernameLower: key, shareLocation: current.shareLocation }, { merge: true });
  await batch.commit();
  current.username = name.trim();
  emit();
}

window.NavicAuth = {
  onState(cb) { stateCb = cb; emit(); },

  async signUp(email, password, username) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await claimUsername(cred.user.uid, username);
  },
  async signIn(email, password) { await signInWithEmailAndPassword(auth, email, password); },
  async signOut() { await fbSignOut(auth); },
  async resetPassword(email) { await sendPasswordResetEmail(auth, email); },

  async changePassword(currentPassword, newPassword) {
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
    await updatePassword(user, newPassword);
  },

  async deleteAccount(currentPassword) {
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
    const uid = user.uid;
    if (current.username) await deleteDoc(doc(db, 'usernames', lower(current.username))).catch(() => {});
    for (const f of [...current.friends, ...current.incoming, ...current.outgoing]) {
      await deleteDoc(doc(db, 'links', linkId(uid, f.uid))).catch(() => {});
    }
    await deleteDoc(doc(db, 'users', uid)).catch(() => {});
    await deleteUser(user);
  },

  async setUsername(name) {
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    await claimUsername(user.uid, name);
  },

  async addFriend(username) {
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    const key = lower(username);
    const uSnap = await getDoc(doc(db, 'usernames', key));
    if (!uSnap.exists()) throw new Error('No user with that name.');
    const otherUid = uSnap.data().uid;
    if (otherUid === user.uid) throw new Error("That's your own name.");
    const id = linkId(user.uid, otherUid);
    const ref = doc(db, 'links', id);
    const existing = await getDoc(ref);
    if (existing.exists()) throw new Error('A request already exists with this user.');
    await setDoc(ref, {
      members: [user.uid, otherUid].sort(),
      requestedBy: user.uid,
      status: 'pending',
      usernames: { [user.uid]: current.username, [otherUid]: username.trim() },
      createdAt: serverTimestamp()
    });
  },

  async acceptRequest(theirUid) {
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    await updateDoc(doc(db, 'links', linkId(user.uid, theirUid)), { status: 'accepted' });
  },

  async removeFriend(theirUid) {
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    await deleteDoc(doc(db, 'links', linkId(user.uid, theirUid)));
  },

  async setShareLocation(on) {
    console.log('[navic] setShareLocation called with', on);
    const user = auth.currentUser; if (!user) throw new Error('Not signed in.');
    current.shareLocation = on;
    await setDoc(doc(db, 'users', user.uid), { shareLocation: on }, { merge: true });
    console.log('[navic] setShareLocation write OK');
    if (!on) await updateDoc(doc(db, 'users', user.uid), { lat: null, lon: null }).catch(() => {});
    emit();
  },

  async pushLocation(lat, lon) {
    const user = auth.currentUser;
    if (!user) { console.log('[navic] pushLocation skipped: not signed in'); return; }
    if (!current.shareLocation) { console.log('[navic] pushLocation skipped: sharing is off'); return; }
    const now = Date.now();
    if (now - lastPushAt < 8000) { console.log('[navic] pushLocation skipped: throttled'); return; }
    lastPushAt = now;
    console.log('[navic] pushLocation writing', lat, lon);
    await setDoc(doc(db, 'users', user.uid), { lat, lon, updatedAt: serverTimestamp() }, { merge: true })
      .then(() => console.log('[navic] pushLocation OK'))
      .catch(e => console.log('[navic] pushLocation FAILED', e.code || e.message || e));
  }
};
