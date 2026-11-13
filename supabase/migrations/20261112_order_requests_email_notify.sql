-- Aviso por e-mail (Resend) a cada pedido novo do fichário.
-- A chave da API e o e-mail de destino ficam no Vault do Supabase (NÃO no código):
--   select vault.create_secret('<RESEND_API_KEY>', 'resend_api_key', '...');
--   select vault.create_secret('<email da conta Resend>', 'order_notify_email', '...');
-- Sem domínio próprio no Resend, só é possível enviar para o e-mail da conta Resend.
-- O envio é assíncrono (pg_net) e uma falha nunca impede o pedido de ser gravado.

create or replace function public.fmt_brl(v numeric) returns text
language sql immutable as $$ select 'R$ ' || translate(to_char(coalesce(v,0), 'FM999G999G990D00'), ',.', '.,') $$;

create or replace function public.notify_order_request_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_to text;
  v_owner text;
  v_rows text := '';
  it jsonb;
  v_wa text;
  v_html text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  select decrypted_secret into v_to from vault.decrypted_secrets where name = 'order_notify_email';
  if v_key is null or v_to is null then return new; end if;

  -- só avisa os pedidos do dono do e-mail configurado (o app tem outros usuários)
  select email into v_owner from auth.users where id = new.user_id;
  if v_owner is distinct from v_to then return new; end if;

  for it in select * from jsonb_array_elements(new.items) loop
    v_rows := v_rows || '<tr><td style="padding:4px 8px">' || (it->>'qty') || 'x</td><td style="padding:4px 8px">'
      || replace(replace(replace(coalesce(it->>'name',''),'&','&amp;'),'<','&lt;'),'>','&gt;')
      || ' <span style="color:#888">' || concat_ws(' · ', nullif(it->>'condition',''), nullif(it->>'language',''), nullif(it->>'extras','')) || '</span></td>'
      || '<td style="padding:4px 8px;text-align:right">' || fmt_brl((it->>'unit_price')::numeric * (it->>'qty')::int) || '</td></tr>';
  end loop;

  v_wa := regexp_replace(new.customer_whatsapp, '[^0-9]', '', 'g');
  if char_length(v_wa) <= 11 then v_wa := '55' || v_wa; end if;

  v_html := '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">'
    || '<h2 style="margin:0 0 8px">Novo pedido #' || new.request_no || ' no fichário</h2>'
    || '<p style="margin:0 0 12px"><b>' || replace(replace(new.customer_name,'<','&lt;'),'>','&gt;') || '</b> · WhatsApp: '
    || '<a href="https://wa.me/' || v_wa || '">' || new.customer_whatsapp || '</a></p>'
    || '<table style="border-collapse:collapse;border:1px solid #eee">' || v_rows
    || '<tr><td></td><td style="padding:6px 8px;font-weight:bold">Total</td><td style="padding:6px 8px;text-align:right;font-weight:bold">'
    || fmt_brl(new.total) || '</td></tr></table>'
    || coalesce('<p style="margin:12px 0 0"><b>Obs.:</b> ' || replace(replace(new.notes,'<','&lt;'),'>','&gt;') || '</p>', '')
    || '<p style="margin:16px 0 0"><a href="https://zeraoratcgp.vercel.app/">Abrir a aba Pedidos no app</a></p></div>';

  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', 'VCards Pedidos <onboarding@resend.dev>',
        'to', jsonb_build_array(v_to),
        'subject', 'Novo pedido #' || new.request_no || ' — ' || new.customer_name || ' — ' || fmt_brl(new.total),
        'html', v_html));
  exception when others then
    null;
  end;
  return new;
end;
$$;

revoke all on function public.notify_order_request_email() from public;

drop trigger if exists trg_order_requests_email on public.order_requests;
create trigger trg_order_requests_email
after insert on public.order_requests
for each row execute function public.notify_order_request_email();
