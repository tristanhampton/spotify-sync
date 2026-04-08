#!/usr/bin/env node
/**
 * One-time setup: authenticates with Spotify and prints your refresh token.
 * Run this locally, then add the token to your Netlify environment variables.
 *
 * Usage:
 *   SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node setup/get-refresh-token.js
 *
 * In your Spotify app settings, set the Redirect URI to:
 *   http://127.0.0.1:8888/callback
 */

import http from 'http';
import { exec } from 'child_process';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-library-read playlist-modify-public playlist-modify-private';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET before running.');
  process.exit(1);
}

const authUrl =
  'https://accounts.spotify.com/authorize?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });

console.log('\nOpening Spotify login in your browser...');
console.log('(If it does not open, paste this URL into your browser manually:)');
console.log('\n' + authUrl + '\n');

exec(`open "${authUrl}"`, () => {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8888');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`<h2>Auth failed: ${error}</h2>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end('<h2>No code received.</h2>');
    return;
  }

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await tokenRes.json();

  if (!data.refresh_token) {
    res.end(`<h2>Error getting token</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    server.close();
    return;
  }

  res.end('<h2>Success! You can close this tab and check your terminal.</h2>');
  server.close();

  console.log('\n' + '='.repeat(60));
  console.log('SUCCESS! Add this to your Netlify environment variables:');
  console.log('='.repeat(60));
  console.log(`\nSPOTIFY_REFRESH_TOKEN=${data.refresh_token}\n`);
  console.log('='.repeat(60));
});

server.listen(8888, '127.0.0.1', () => {
  console.log('Waiting for Spotify callback on http://127.0.0.1:8888/callback ...');
});
