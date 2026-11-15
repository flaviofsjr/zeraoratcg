-- Desejos reformulado: radar de diferença de preço Liga x plataformas internacionais
-- Aditivo: colunas antigas (target_price, last_price, last_checked_date, review_frequency_days) ficam no banco.

alter table public.wishlist
  add column if not exists liga_price numeric,
  add column if not exists liga_checked_at date,
  add column if not exists intl_platform text,
  add column if not exists intl_price numeric,
  add column if not exists intl_currency text not null default 'USD',
  add column if not exists intl_shipping numeric not null default 0,
  add column if not exists intl_url text,
  add column if not exists intl_checked_at date,
  add column if not exists import_route text not null default 'maos',
  add column if not exists extra_cost_pct numeric;

-- O "último preço visto" antigo era o preço da Liga
update public.wishlist
   set liga_price = coalesce(liga_price, last_price),
       liga_checked_at = coalesce(liga_checked_at, last_checked_date)
 where last_price is not null;

create table if not exists public.wishlist_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  card_fee_pct numeric not null default 3.5,       -- IOF (3,5%) + spread do cartão na compra internacional
  import_tax_pct numeric not null default 60,      -- impostos quando a carta vem importada (rota "importacao")
  min_spread_pct numeric not null default 30,      -- diferença mínima para contar como oportunidade
  review_days integer not null default 15,         -- depois disso o preço é considerado desatualizado
  fx_manual jsonb,                                 -- cotações fixadas à mão, ex {"USD":5.4}; null = automática
  updated_at timestamptz not null default now()
);

alter table public.wishlist_settings enable row level security;

drop policy if exists "Users manage their own wishlist settings" on public.wishlist_settings;
create policy "Users manage their own wishlist settings" on public.wishlist_settings
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
