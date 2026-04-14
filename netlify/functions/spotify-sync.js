/**
 * Netlify Scheduled Function
 * Keeps an "All Library" Spotify playlist in sync with your saved tracks + saved albums.
 * Schedule: daily at 6am UTC (change below to taste — uses cron syntax)
 */

export const config = {
  schedule: '0 6 * * *',
};

const PLAYLIST_NAME = process.env.PLAYLIST_NAME || 'My Library';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

// --- Auth ---

async function getAccessToken() {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = process.env;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
    throw new Error('Missing SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, or SPOTIFY_REFRESH_TOKEN env vars.');
  }

  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// --- Spotify API helpers ---

async function spotifyGet(token, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function paginate(token, firstPage) {
  const items = [];
  let page = firstPage;
  while (page) {
    items.push(...page.items);
    if (page.next) {
      const res = await fetch(page.next, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      page = await res.json();
    } else {
      page = null;
    }
  }
  return items;
}

// --- Library fetching ---

async function getSavedTrackUris(token) {
  const first = await spotifyGet(token, '/me/tracks?limit=50');
  const items = await paginate(token, first);
  return new Set(items.map((i) => i.track?.uri).filter(Boolean));
}

async function getSavedAlbumTrackUris(token) {
  const first = await spotifyGet(token, '/me/albums?limit=50');
  const albumItems = await paginate(token, first);
  const uris = new Set();

  for (const item of albumItems) {
    const { tracks } = item.album;
    // Tracks are already included inline (up to 50). Use them directly.
    for (const t of tracks.items) uris.add(t.uri);
    // Only fetch more if the album has >50 tracks (box sets, etc.)
    if (tracks.next) {
      const extra = await paginate(token, { items: [], next: tracks.next });
      for (const t of extra) uris.add(t.uri);
    }
  }

  return uris;
}

// --- Playlist management ---

async function getOrCreatePlaylist(token, name) {
  // If PLAYLIST_ID is set, skip the lookup entirely — avoids re-creating on every run.
  if (process.env.PLAYLIST_ID) {
    // Strip any share parameters (e.g. ?si=...) that may have been copied from a Spotify share URL.
    const playlistId = process.env.PLAYLIST_ID.split('?')[0];
    console.log(`Using playlist ID from env: ${playlistId}`);
    return playlistId;
  }

  const me = await spotifyGet(token, '/me');
  const userId = me.id;

  const first = await spotifyGet(token, '/me/playlists?limit=50');
  const playlists = await paginate(token, first);
  const existing = playlists.find((p) => p.name === name && p.owner.id === userId);
  if (existing) {
    console.log(`Found existing playlist: "${name}" (${existing.id})`);
    console.log(`TIP: Set PLAYLIST_ID=${existing.id} in Netlify env vars to skip this lookup.`);
    return existing.id;
  }

  const res = await fetch(`${API_BASE}/users/${userId}/playlists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      public: false,
      description: 'Auto-synced from full Spotify library.',
    }),
  });
  if (!res.ok) throw new Error(`Failed to create playlist: ${res.status}`);
  const data = await res.json();
  console.log(`Created new playlist: "${name}" (${data.id})`);
  console.log(`ACTION REQUIRED: Set PLAYLIST_ID=${data.id} in Netlify env vars to prevent creating duplicates.`);
  return data.id;
}

async function getPlaylistTrackUris(token, playlistId) {
  const first = await spotifyGet(token, `/playlists/${playlistId}/tracks?limit=100&fields=items(track(uri)),next`);
  const items = await paginate(token, first);
  return new Set(items.map((i) => i.track?.uri).filter(Boolean));
}

function chunks(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

async function syncPlaylist(token, playlistId, targetUris) {
  const currentUris = await getPlaylistTrackUris(token, playlistId);

  const toAdd = [...targetUris].filter((u) => !currentUris.has(u));
  const toRemove = [...currentUris].filter((u) => !targetUris.has(u));

  for (const chunk of chunks(toAdd, 100)) {
    await fetch(`${API_BASE}/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: chunk }),
    });
  }

  for (const chunk of chunks(toRemove, 100)) {
    await fetch(`${API_BASE}/playlists/${playlistId}/tracks`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: chunk.map((uri) => ({ uri })) }),
    });
  }

  return { added: toAdd.length, removed: toRemove.length };
}

// --- Entry point ---

export default async () => {
  console.log('spotify-sync: starting');

  const token = await getAccessToken();

  console.log('Fetching liked songs...');
  const savedTracks = await getSavedTrackUris(token);
  console.log(`  ${savedTracks.size} liked songs`);

  console.log('Fetching saved albums...');
  const albumTracks = await getSavedAlbumTrackUris(token);
  console.log(`  ${albumTracks.size} tracks across saved albums`);

  const allTracks = new Set([...savedTracks, ...albumTracks]);
  console.log(`  ${allTracks.size} unique tracks total`);

  const playlistId = await getOrCreatePlaylist(token, PLAYLIST_NAME);
  const { added, removed } = await syncPlaylist(token, playlistId, allTracks);

  console.log(`spotify-sync: done — +${added} added, -${removed} removed`);
};
