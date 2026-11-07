// Avalia a condicao de uma carta a partir de fotos (frente, verso e closes opcionais).
// Usa a API da Anthropic (segredo ANTHROPIC_API_KEY) e devolve uma sugestao na escala da Liga
// (M, NM, SP, MP, HP, D), com a condicao vizinha mais provavel e o que desempata.
// Grava cada avaliacao em card_gradings (RLS: so o dono ve).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SCALE = ["M", "NM", "SP", "MP", "HP", "D"];
const MAX_IMAGES = 6;
const MAX_B64 = 5 * 1024 * 1024; // limite por imagem da API

const RUBRIC = `Escala de condicao (padrao Liga Pokemon, do melhor ao pior):
- M (Mint): perfeita. Nenhum defeito visivel mesmo de perto, frente e verso. Cantos afiados, bordas sem nenhum ponto branco, holo sem riscos.
- NM (Near Mint): parece nova a olho nu. Admite no maximo 1-2 pontinhos minusculos de whitening no verso ou um defeito de fabrica minimo, so percebido procurando. Sem riscos visiveis no holo.
- SP (Slightly Played): desgaste leve mas perceptivel: varios pontos brancos nas bordas do verso, inicio de whitening em cantos, riscos leves no holo/superficie visiveis contra a luz. Sem dobras.
- MP (Moderately Played): desgaste evidente: whitening continuo em bordas/cantos, cantos levemente arredondados, riscos claros, marcas de manuseio, pequena dobra sem vinco forte.
- HP (Heavily Played): desgaste pesado: dobras/vincos, cantos bem gastos, superficie muito riscada ou manchada, mas carta integra.
- D (Damaged): rasgos, dobras fortes, agua, escrita, adesivo, perda de material, empenamento serio.
Regras: o pior criterio limita a nota final. O verso conta tanto quanto a frente (whitening aparece mais no verso de borda azul). Centralizacao ruim por si so nao derruba abaixo de NM na Liga, mas registre. Ajuste +/-: use "+" quando a carta esta no topo da faixa (quase a condicao de cima, ex.: SP+ = quase NM) e "-" quando esta no limite inferior (perto da de baixo, ex.: NM- = quase SP, com detalhes minimos que um comprador exigente notaria). Deixe vazio quando estiver claramente no meio da faixa. Use o ajuste justamente nos casos de fronteira entre duas condicoes. Nao confunda reflexo, poeira, sleeve ou compressao da foto com defeito: quando nao der para ter certeza, diga e peca a foto que resolveria.`;

const TOOL = {
  name: "registrar_avaliacao",
  description: "Registra a avaliacao de condicao da carta.",
  input_schema: {
    type: "object",
    properties: {
      condicao_sugerida: { type: "string", enum: SCALE },
      ajuste: { type: "string", enum: ["+", "-", ""], description: "+ topo da faixa (quase a de cima), - limite inferior (perto da de baixo), vazio se no meio." },
      condicao_alternativa: { type: "string", enum: SCALE, description: "Condicao vizinha mais provavel (a outra ponta da duvida)." },
      probabilidade_sugerida: { type: "number", description: "0 a 100: chance de a condicao sugerida ser a correta frente a alternativa." },
      resumo: { type: "string", description: "1-2 frases em portugues explicando a nota." },
      criterios: {
        type: "array",
        items: {
          type: "object",
          properties: {
            lado: { type: "string", enum: ["frente", "verso"] },
            criterio: { type: "string", enum: ["cantos", "bordas", "superficie", "centralizacao"] },
            nota: { type: "string", enum: SCALE },
            comentario: { type: "string" },
          },
          required: ["lado", "criterio", "nota", "comentario"],
        },
      },
      defeitos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            lado: { type: "string", enum: ["frente", "verso"] },
            local: { type: "string", description: "Onde esta, ex.: 'borda inferior, perto do canto esquerdo'." },
            tipo: { type: "string", description: "whitening, risco, dobra, mancha, amassado, impressao etc." },
            gravidade: { type: "string", enum: ["minimo", "leve", "moderado", "grave"] },
            certeza: { type: "string", enum: ["alta", "media", "baixa"] },
          },
          required: ["lado", "local", "tipo", "gravidade", "certeza"],
        },
      },
      o_que_desempata: { type: "string", description: "O que decide entre a sugerida e a alternativa, e como conferir na mao." },
      fotos_extras: { type: "array", items: { type: "string" }, description: "Fotos que aumentariam a certeza (vazio se nao precisar)." },
      alerta_autenticidade: { type: "string", description: "Preencha so se algo parecer fora do padrao de uma carta original; senao string vazia." },
    },
    required: ["condicao_sugerida", "ajuste", "condicao_alternativa", "probabilidade_sugerida", "resumo", "criterios", "defeitos", "o_que_desempata", "fotos_extras", "alerta_autenticidade"],
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u, error: ue } = await sb.auth.getUser();
    if (ue || !u?.user) return json({ error: "Nao autenticado" }, 401);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Falta configurar o segredo ANTHROPIC_API_KEY nas Edge Functions do Supabase." }, 500);
    const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";

    const body = await req.json();
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    if (images.length < 2) return json({ error: "Envie pelo menos a frente e o verso." }, 400);
    for (const im of images) {
      if (!im?.data || typeof im.data !== "string" || im.data.length > MAX_B64) return json({ error: "Imagem invalida ou grande demais: " + (im?.label || "?") }, 400);
    }
    const card = body.card || {};

    const content: any[] = [];
    for (const im of images) {
      content.push({ type: "text", text: "Foto: " + String(im.label || "sem rotulo").slice(0, 60) });
      content.push({ type: "image", source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data } });
    }
    const info = [
      card.name ? "Carta: " + card.name : null,
      card.set ? "Colecao: " + card.set : null,
      card.language ? "Idioma: " + card.language : null,
      card.current_condition ? "Condicao cadastrada hoje: " + card.current_condition + " (nao se deixe influenciar; avalie pelas fotos)" : null,
      card.notes ? "Observacao do vendedor: " + String(card.notes).slice(0, 300) : null,
    ].filter(Boolean).join("\n");
    content.push({ type: "text", text: (info ? info + "\n\n" : "") + "Avalie a condicao desta carta para revenda e registre com a ferramenta. Seja rigoroso e especifico sobre onde estao os defeitos. Responda em portugues." });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: "Voce e um avaliador experiente de cartas Pokemon TCG para revenda no Brasil.\n\n" + RUBRIC,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content }],
      }),
    });
    const j = await res.json();
    if (!res.ok) return json({ error: "Erro na IA: " + (j?.error?.message || res.status) }, 502);
    const tu = (j.content || []).find((c: any) => c.type === "tool_use");
    if (!tu) return json({ error: "A IA nao devolveu a avaliacao." }, 502);
    const r = tu.input;

    const row = {
      user_id: u.user.id,
      inventory_id: body.inventory_id || null,
      card_name: card.name || null,
      suggested_condition: r.condicao_sugerida,
      suggested_mod: r.ajuste === "+" || r.ajuste === "-" ? r.ajuste : null,
      alt_condition: r.condicao_alternativa,
      confidence: r.probabilidade_sugerida,
      result: r,
      model,
    };
    const ins = await sb.from("card_gradings").insert(row).select("id").single();
    return json({ id: ins.data?.id || null, result: r, usage: j.usage || null });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
