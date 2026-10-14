-- Immo Objektcheck: Datenbank einrichten
-- In Supabase: SQL Editor → New query → alles einfügen → Run

-- 1) Gespeicherte Objekte, jeder Nutzer sieht nur seine eigenen
create table if not exists public.objekte (
  id        text primary key,
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name      text,
  info      text,
  state     jsonb not null,
  saved_at  timestamptz not null default now()
);
create index if not exists objekte_user_saved on public.objekte (user_id, saved_at desc);
alter table public.objekte enable row level security;

drop policy if exists "objekte lesen"    on public.objekte;
drop policy if exists "objekte anlegen"  on public.objekte;
drop policy if exists "objekte aendern"  on public.objekte;
drop policy if exists "objekte loeschen" on public.objekte;
create policy "objekte lesen"    on public.objekte for select using (auth.uid() = user_id);
create policy "objekte anlegen"  on public.objekte for insert with check (auth.uid() = user_id);
create policy "objekte aendern"  on public.objekte for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "objekte loeschen" on public.objekte for delete using (auth.uid() = user_id);

-- 2) Marktdaten: jeder darf lesen, schreiben nur der Server (Service-Key)
create table if not exists public.market (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.market enable row level security;
drop policy if exists "market lesen" on public.market;
create policy "market lesen" on public.market for select using (true);

-- 3) Startwerte (Stand 07.10.2026)
insert into public.market (id, data) values ('current', '{
  "stand": "07.10.2026",
  "zins": {"5": 4.36, "10": 4.11, "15": 4.28, "20": 4.36, "30": 4.59},
  "zinsQuelle": "Dr. Klein Topzinsen, Stand 07.10.2026",
  "aufschlag": 0.35,
  "kfw308": 0.53,
  "kfw308Max": {"1": 140000, "2": 160000, "3": 180000},
  "grest": {"BW":5.0,"BY":3.5,"BE":6.0,"BB":6.5,"HB":5.5,"HH":5.5,"HE":6.0,"MV":6.0,"NI":5.0,"NW":6.5,"RP":5.0,"SL":6.5,"SN":5.5,"ST":5.0,"SH":6.5,"TH":5.0},
  "notar": 1.5, "grundbuch": 0.5, "makler": 3.57,
  "bk": 2.67, "bkMax": 3.68, "heiz": 1.32,
  "instEigen": 1.0, "inst22": 13.45, "inst32": 17.18,
  "baupreis": 5.6, "stundensatz": 62,
  "mietpreisbremse": "BW: gilt bis 31.12.2026, Verlängerung vom Land geplant (Meldung 22.09.2026)"
}'::jsonb)
on conflict (id) do nothing;
