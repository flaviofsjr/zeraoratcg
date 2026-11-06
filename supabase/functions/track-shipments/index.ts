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
const MR_QUERY = `mutation searchParcel ($tracker: TrackerSearchInput!) { result: searchParcel (tracker: $tracker) { lastStatus postedAt estimatedDelivery deliveredAt trackers { trackingCode type } trackingEvents { trackerType trackingCode createdAt title description from to location { city state } } } }`;
const S10 = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const CARRIER_TYPE: Record<string, string> = { "Correios": "correios", "Loggi": "loggi", "Jadlog": "jadlog" };
const MAX_PER_RUN = 40;

function trackerType(code: string, carrier: string | null, platform: string | null): string {
  // O formato do codigo manda: AA123456789BR e sempre Correios, mesmo comprado no Melhor Envio
  if (S10.test(code)) return "correios";
  if (/^ME[A-Z0-9]{8,}$/.test(code)) return "melhorenvio";
  if (carrier && CARRIER_TYPE[carrier]) return CARRIER_TYPE[carrier];
  if (platform === "Melhor Envio") return "melhorenvio";
  return "unknown";
}

// "01 - SAO BERNARDO DO CAMPO/SP" -> "Sao Bernardo do Campo/SP"
function cleanPlace(p: string | null | undefined): string | null {
  if (!p) return null;
  let t = String(p).replace(/^\s*\d+\s*-\s*/, "").trim();
  if (!t) return null;
  const parts = t.split("/");
  let city = parts[0].trim();
  const uf = (parts[1] || "").trim().toUpperCase();
  if (city === city.toUpperCase()) {
    city = city.toLowerCase().split(/\s+/).map((w, i) => (i > 0 && /^(de|da|do|das|dos|e)$/.test(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return city + (uf ? "/" + uf : "");
}

// Data local (Brasil, UTC-3) a partir de um ISO
function localDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function evPlace(e: any): string | null {
  if (!e) return null;
  if (e.location?.city) return cleanPlace(e.location.city + (e.location.state ? "/" + e.location.state : ""));
  return cleanPlace(e.from);
}

function norm(s: string) { return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

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

    let q = sb.from("shipments").select("id,tracking_code,carrier,platform,status,direction,shipped_date,expected_date,origin,destination").eq("user_id", u.user.id)
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
        const loc = evPlace(last) || "";
        const suggested = suggestStatus(r?.lastStatus || "", last, evs.length);
        // Origem: primeiro evento com local; destino: ultimo "to" informado ou local da entrega
        const chrono = evs.slice().reverse();
        const origin = evPlace(chrono.find((e: any) => evPlace(e))) ;
        const toEv = evs.find((e: any) => e.to);
        const deliveredEv = suggested === "Entregue" ? last : null;
        const destination = cleanPlace(toEv && toEv.to) || evPlace(deliveredEv);
        const posted = localDate(r?.postedAt) || localDate(chrono.find((e: any) => /coletad|postad/i.test(e.title || ""))?.createdAt);
        const eta = localDate(r?.estimatedDelivery);
        const upd: Record<string, unknown> = {
          tracking_last_title: last?.title || null,
          tracking_last_desc: last?.description || null,
          tracking_last_location: loc || null,
          tracking_last_at: last?.createdAt || null,
          tracking_events: evs.slice(0, 30).map((e: any) => ({ at: e.createdAt, title: e.title, desc: e.description, from: e.from, to: e.to, city: e.location?.city || null, state: e.location?.state || null })),
          tracking_suggested_status: suggested,
          tracking_synced_at: now,
          tracking_error: evs.length ? null : "Nenhum evento encontrado ainda",
        };
        if (!s.shipped_date && posted) upd.shipped_date = posted;      // nao sobrescreve a data que voce digitou
        if (eta && eta !== s.expected_date) upd.expected_date = eta;   // previsao da transportadora sempre atualiza
        if (!s.origin && origin) upd.origin = origin;
        if (!s.destination && destination) upd.destination = destination;
        await sb.from("shipments").update(upd).eq("id", s.id);
        results.push({ id: s.id, ok: true, events: evs.length, suggested, title: upd.tracking_last_title, at: upd.tracking_last_at, shipped_date: upd.shipped_date ?? null, expected_date: upd.expected_date ?? null });
      } catch (e) {
        let msg = (e as Error).message || String(e);
        if (/bad request/i.test(msg)) msg = type === "jadlog" || s.carrier === "Jadlog"
          ? "Jadlog sem rastreio automático (o site exige captcha) — use o link"
          : "Código não encontrado no rastreio automático — confira o código ou use o link";
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
