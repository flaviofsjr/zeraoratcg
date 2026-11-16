-- Dados de envio do cliente (etiqueta Melhor Envio / SuperFrete)
alter table public.customers
  add column if not exists full_name text,
  add column if not exists cpf text,
  add column if not exists cep text,
  add column if not exists address_street text,
  add column if not exists address_number text,
  add column if not exists address_complement text,
  add column if not exists address_district text,
  add column if not exists state text;
