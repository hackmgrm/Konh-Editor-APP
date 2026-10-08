import { createClient } from 'npm:@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' };
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return new Response('{}', { status: 405, headers: cors });
  const authorization = request.headers.get('Authorization') ?? '';
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await admin.auth.getUser(authorization.replace(/^Bearer /i, ''));
  if (error || !data.user) return new Response('{"error":"Unauthorized"}', { status: 401, headers: cors });
  const result = await admin.auth.admin.deleteUser(data.user.id);
  return new Response(JSON.stringify(result.error ? { error: 'Account deletion failed' } : { deleted: true }), { status: result.error ? 500 : 200, headers: cors });
});
