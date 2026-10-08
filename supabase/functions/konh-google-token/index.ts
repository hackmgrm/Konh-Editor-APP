import { createClient } from 'npm:@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' };
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return new Response('{}', { status: 405, headers: cors });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await admin.auth.getUser((request.headers.get('Authorization') ?? '').replace(/^Bearer /i, ''));
  if (error || !data.user) return new Response('{"error":"Unauthorized"}', { status: 401, headers: cors });
  let body;
  try { body = await request.json(); } catch { return new Response('{}', { status: 400, headers: cors }); }
  if (typeof body.refresh_token !== 'string' || !body.refresh_token || body.refresh_token.length > 4096) return new Response('{}', { status: 400, headers: cors });
  const client_id = Deno.env.get('GOOGLE_CLIENT_ID'); const client_secret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!client_id || !client_secret) return new Response('{"error":"Google provider is not configured"}', { status: 503, headers: cors });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id, client_secret, refresh_token: body.refresh_token, grant_type: 'refresh_token' }) });
  if (!response.ok) return new Response('{"error":"Please reconnect Google Calendar"}', { status: 401, headers: cors });
  const token = await response.json();
  return new Response(JSON.stringify({ access_token: token.access_token, expires_in: token.expires_in }), { headers: { ...cors, 'Cache-Control': 'no-store' } });
});
