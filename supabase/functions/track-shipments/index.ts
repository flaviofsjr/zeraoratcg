// Atualiza o rastreio dos envios em aberto do usuario logado.
// Fonte: API publica usada pelo site Melhor Rastreio (nao oficial, sem chave).
// Nao muda o status do envio: grava o ultimo evento e um "status sugerido";
// o app aplica a mudanca (assim os fluxos de Entregue continuam pedindo confirmacao).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MR_URL = "https://api.melhorrastreio.com.br/graphql";
const MR_QUERY = `mutation searchParcel ($tracker: TrackerSearchInput!) { result: searchParcel (tracker: $tracker) { lastStatus trackers { trackingCode type } trackingEvents { trackerType trackingCode createdAt title description from to location { city state } } } }`;
const S10 = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const CARRIER_TYPE: Record<string, string> = { "Correios": "correios", "Loggi": "loggi", "Jadlog": "jadlog" };
const MAX_PER_RUN = 40;

function trackerType(code: string, carrier: string | null, platform: string | null): string {
  if (/^ME[A-Z0-9]{8,}$/.test(code) || platform === "Melhor Envio") return "melhorenvio";
  if (carrier && CARRIER_TYPE[carrier]) return CARRIER_TYPE[carrier];
  if (S10.test(code)) return "correios";
  return "unknown";
}

function norm(s: string) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function suggestStatus(lastStatus: string, ev: any, count: number): string | null {
  const t = norm((ev?.title || "") + " " + (ev?.description || ""));
  if (lastStatus === "DELIVERED") return "Entregue";
  if (/nao (foi )?entregue|devolvid|extraviad|roubad|endereco incorreto|destinatario ausente|tentativa de entrega/.test(t)) return "Problema";
  if (/\bentregue\b|objeto entregue|pacote entregue/.test(t)) return "Entregue";
  if (/saiu para entrega|em rota de entrega|rota de entrega/.test(t)) return "Saiu para entrega";
  if (/aguardando retirada|disponivel para retirada|retirar/.test(t)) return "Aguardando retirada";
  if (/fiscaliza|aduan|tribut|importacao|pagamento/.test(t)) return "Na alfândega";
  if (!count) return null;
  if (count === 1 && /adicionado no sistema|etiqueta|postagem pendente|aguardando postagem/.test(t)) return "Postado";
  return "Em trânsito";
}

async function fetchTracking(code: string, type: string) {
  const res = await fetch(MR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://www.melhorrastreio.com.br", "User-Agent": "Mozilla/5.0 (compatible; VCards-Manager)" },
    body: JSON.stringify({ query: MR_QUERY, variables: { tracker: { trackingCode: code, type } } }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  if (j.errors?.length) throw new Error(j.errors[0].message || "erro na consulta");
  return j.data?.result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const auth = req.headers.get("Authorization") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u, error: ue } = await sb.auth.getUser();
    if (ue || !u?.user) return json({ error: "não autenticado" }, 401);
    let ids: string[] | null = null;
    try { const b = await req.json(); if (Array.isArray(b?.ids) && b.ids.length) ids = b.ids; } catch (_) { /* sem corpo */ }

    let q = sb.from("shipments").select("id,tracking_code,carrier,platform,status").eq("user_id", u.user.id)
      .neq("status", "Entregue").not("tracking_code", "is", null);
    if (ids) q = q.in("id", ids);
    const { data: rows, error } = await q.order("tracking_synced_at", { ascending: true, nullsFirst: true }).limit(MAX_PER_RUN);
    if (error) return json({ error: error.message }, 500);

    const results: any[] = [];
    for (const s of rows || []) {
      if (s.carrier === "Entrega local") continue;
      const code = String(s.tracking_code).toUpperCase().replace(/\s+/g, "");
      const type = trackerType(code, s.carrier, s.platform);
      const now = new Date().toISOString();
      try {
        const r = await fetchTracking(code, type);
        const evs = (r?.trackingEvents || []).slice().sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1));
        const last = evs[0] || null;
        const loc = last ? (last.location?.city ? last.location.city + (last.location.state ? "/" + last.location.state : "") : (last.from || "")) : "";
        const suggested = suggestStatus(r?.lastStatus || "", last, evs.length);
        const upd = {
          tracking_last_title: last?.title || null,
          tracking_last_desc: last?.description || null,
          tracking_last_location: loc || null,
          tracking_last_at: last?.createdAt || null,
          tracking_events: evs.slice(0, 30).map((e: any) => ({ at: e.createdAt, title: e.title, desc: e.description, from: e.from, to: e.to, city: e.location?.city || null, state: e.location?.state || null })),
          tracking_suggested_status: suggested,
          tracking_synced_at: now,
          tracking_error: evs.length ? null : "Nenhum evento encontrado ainda",
        };
        await sb.from("shipments").update(upd).eq("id", s.id);
        results.push({ id: s.id, ok: true, events: evs.length, suggested, title: upd.tracking_last_title, at: upd.tracking_last_at });
      } catch (e) {
        const msg = (e as Error).message || String(e);
        await sb.from("shipments").update({ tracking_synced_at: now, tracking_error: msg }).eq("id", s.id);
        results.push({ id: s.id, ok: false, error: msg });
      }
      await new Promise((r) => setTimeout(r, 400)); // gentil com a fonte
    }
    return json({ checked: results.length, results });
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
