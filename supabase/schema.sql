-- Immo Objektcheck: Datenbank einrichten
-- In Supabase: SQL Editor → New query → alles einfügen → Run

-- 1) Gespeicherte Objekte, jeder Nutzer sieht nur seine eigenen
create table if not exists public.immo_objekte (
  id        text primary key,
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name      text,
  info      text,
  state     jsonb not null,
  saved_at  timestamptz not null default now()
);
create index if not exists immo_objekte_user_saved on public.immo_objekte (user_id, saved_at desc);
alter table public.immo_objekte enable row level security;

drop policy if exists "immo objekte lesen"    on public.immo_objekte;
drop policy if exists "immo objekte anlegen"  on public.immo_objekte;
drop policy if exists "immo objekte aendern"  on public.immo_objekte;
drop policy if exists "immo objekte loeschen" on public.immo_objekte;
create policy "immo objekte lesen"    on public.immo_objekte for select using (auth.uid() = user_id);
create policy "immo objekte anlegen"  on public.immo_objekte for insert with check (auth.uid() = user_id);
create policy "immo objekte aendern"  on public.immo_objekte for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "immo objekte loeschen" on public.immo_objekte for delete using (auth.uid() = user_id);

-- 2) Marktdaten: jeder darf lesen, schreiben nur der Server (Service-Key)
create table if not exists public.immo_market (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.immo_market enable row level security;
drop policy if exists "immo market lesen" on public.immo_market;
create policy "immo market lesen" on public.immo_market for select using (true);

-- 3) Startwerte (Stand 07.10.2026)
insert into public.immo_market (id, data) values ('current', '{
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

-- 4) Tageszähler für KI-Anfragen (schützt dein API-Guthaben). Nur der Server liest und schreibt.
create table if not exists public.immo_usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  kind     text not null,
  n        int  not null default 0,
  primary key (user_id, day, kind)
);
alter table public.immo_usage enable row level security;
