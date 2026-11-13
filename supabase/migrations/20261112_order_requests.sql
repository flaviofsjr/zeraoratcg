-- Pedidos feitos pelo fichário público (binder.html).
-- O cliente não finaliza a compra: o pedido fica salvo aqui e o vendedor confirma pelo WhatsApp.
-- Nada no estoque é reservado ou baixado automaticamente.

create table if not exists public.order_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_no integer not null,
  customer_name text not null check (char_length(customer_name) between 1 and 80),
  customer_whatsapp text not null check (char_length(customer_whatsapp) between 8 and 30),
  items jsonb not null,
  total numeric(10,2) not null default 0,
  notes text check (notes is null or char_length(notes) <= 500),
  status text not null default 'Novo' check (status in ('Novo','Em contato','Fechado','Cancelado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, request_no)
);

create index if not exists order_requests_user_created_idx on public.order_requests (user_id, created_at desc);

alter table public.order_requests enable row level security;

-- Só o dono vê e mexe nos próprios pedidos. Não há policy de INSERT:
-- o cliente anônimo só consegue criar pedido pela função abaixo.
drop policy if exists order_requests_owner_select on public.order_requests;
create policy order_requests_owner_select on public.order_requests for select using (auth.uid() = user_id);
drop policy if exists order_requests_owner_update on public.order_requests;
create policy order_requests_owner_update on public.order_requests for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists order_requests_owner_delete on public.order_requests;
create policy order_requests_owner_delete on public.order_requests for delete using (auth.uid() = user_id);

-- Recebe o carrinho do fichário, confere no estoque o que está "A venda",
-- recalcula preço e quantidade no servidor (o cliente não consegue alterar valores)
-- e grava o pedido. Retorna o número do pedido, os itens aceitos e os indisponíveis.
create or replace function public.submit_order_request(
  p_slug text,
  p_name text,
  p_whatsapp text,
  p_items jsonb,
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_wa text := regexp_replace(coalesce(p_whatsapp, ''), '[^0-9+]', '', 'g');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_items jsonb := '[]'::jsonb;
  v_unavailable jsonb := '[]'::jsonb;
  v_total numeric := 0;
  it jsonb;
  v_ids uuid[];
  v_qty int;
  v_avail int;
  r record;
  v_no int;
  v_id uuid;
begin
  select user_id into v_uid from public_profiles where slug = p_slug limit 1;
  if v_uid is null then raise exception 'Fichário não encontrado'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then raise exception 'Informe seu nome'; end if;
  if char_length(regexp_replace(v_wa, '[^0-9]', '', 'g')) < 10 or char_length(v_wa) > 20 then raise exception 'Informe um WhatsApp válido com DDD'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then v_notes := left(v_notes, 500); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'O pedido está vazio'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Pedido com itens demais (máx. 100)'; end if;

  -- Proteção simples contra envio repetido
  if (select count(*) from order_requests
        where user_id = v_uid and customer_whatsapp = v_wa and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Muitos pedidos em pouco tempo. Tente novamente em alguns minutos.';
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(1, least(coalesce((it->>'qty')::int, 1), 50));
    select array_agg(x::uuid) into v_ids
      from (select jsonb_array_elements_text(coalesce(it->'ids', '[]'::jsonb)) x limit 50) s;
    if v_ids is null then continue; end if;

    select coalesce(sum(quantity_available), 0) into v_avail
      from inventory
     where id = any(v_ids) and user_id = v_uid and status = 'A venda'
       and quantity_available > 0 and sale_price > 0;

    select name, set_name, condition, condition_mod, language, extras, sale_price, image_url
      into r
      from inventory
     where id = any(v_ids) and user_id = v_uid
     order by (status = 'A venda' and quantity_available > 0) desc, sale_price
     limit 1;

    if v_avail <= 0 or r.name is null then
      v_unavailable := v_unavailable || jsonb_build_object('name', coalesce(r.name, it->>'name'));
      continue;
    end if;

    v_qty := least(v_qty, v_avail);
    v_items := v_items || jsonb_build_object(
      'ids', to_jsonb(v_ids), 'name', r.name, 'set_name', r.set_name,
      'condition', r.condition, 'condition_mod', r.condition_mod, 'language', r.language,
      'extras', r.extras, 'image_url', r.image_url,
      'qty', v_qty, 'requested_qty', coalesce((it->>'qty')::int, 1),
      'unit_price', r.sale_price, 'subtotal', round(r.sale_price * v_qty, 2));
    v_total := v_total + r.sale_price * v_qty;
  end loop;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'Os itens do pedido não estão mais disponíveis';
  end if;

  perform pg_advisory_xact_lock(hashtext('order_requests:' || v_uid::text));
  select coalesce(max(request_no), 0) + 1 into v_no from order_requests where user_id = v_uid;

  insert into order_requests (user_id, request_no, customer_name, customer_whatsapp, items, total, notes)
  values (v_uid, v_no, v_name, v_wa, v_items, round(v_total, 2), v_notes)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'request_no', v_no, 'total', round(v_total, 2),
                            'items', v_items, 'unavailable', v_unavailable);
end;
$$;

revoke all on function public.submit_order_request(text, text, text, jsonb, text) from public;
grant execute on function public.submit_order_request(text, text, text, jsonb, text) to anon, authenticated;
