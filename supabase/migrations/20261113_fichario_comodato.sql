-- Pedidos pelo fichario aceitam itens "A venda" e "Comodato"
CREATE OR REPLACE FUNCTION public.submit_order_request(p_slug text, p_name text, p_whatsapp text, p_items jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     where id = any(v_ids) and user_id = v_uid and status in ('A venda', 'Comodato')
       and quantity_available > 0 and sale_price > 0;

    select name, set_name, condition, condition_mod, language, extras, sale_price, image_url
      into r
      from inventory
     where id = any(v_ids) and user_id = v_uid
     order by (status in ('A venda', 'Comodato') and quantity_available > 0) desc, sale_price
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
$function$;
