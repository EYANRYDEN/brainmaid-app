-- BrainMaid family app: database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Safe to run once.

create extension if not exists pgcrypto;

-- Household and who belongs to it ---------------------------------------
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists members (
  user_id uuid primary key references auth.users on delete cascade,
  household_id uuid not null references households on delete cascade,
  name text not null,
  initials text not null check (initials in ('R','T')),
  created_at timestamptz not null default now()
);

-- Emails allowed to join a household (only these people can see its data)
create table if not exists invites (
  email text primary key,
  household_id uuid not null references households on delete cascade,
  name text not null,
  initials text not null check (initials in ('R','T'))
);

create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from members where user_id = auth.uid()
$$;

create or replace function claim_invite() returns members
language plpgsql security definer set search_path = public as $$
declare m members; i invites;
begin
  select * into m from members where user_id = auth.uid();
  if found then return m; end if;
  select * into i from invites where lower(email) = lower(auth.jwt() ->> 'email');
  if not found then raise exception 'not_invited'; end if;
  insert into members (user_id, household_id, name, initials)
    values (auth.uid(), i.household_id, i.name, i.initials) returning * into m;
  return m;
end $$;

revoke all on function claim_invite() from public;
grant execute on function claim_invite() to authenticated;
grant execute on function my_household() to authenticated;

-- Shared data -------------------------------------------------------------
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  title text not null,
  notes text,
  due date,
  who text not null default 'both' check (who in ('R','T','both')),
  repeat text check (repeat in ('daily','weekly','monthly','yearly')),
  done boolean not null default false,
  done_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  title text not null,
  date date not null,
  time time,
  who text not null default 'both' check (who in ('R','T','both')),
  repeat text check (repeat in ('weekly','monthly','yearly')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  name text not null,
  kind text not null default 'general' check (kind in ('shop','general')),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  list_id uuid not null references lists on delete cascade,
  name text not null,
  qty text,
  aisle text,
  tier text not null default 'w' check (tier in ('w','m')),
  who text check (who in ('R','T','both')),
  done boolean not null default false,
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists meals (
  household_id uuid not null default my_household() references households on delete cascade,
  id text not null,
  week int not null,
  slot int not null,
  title text not null,
  mins int,
  kit text,
  protein text,
  steps jsonb not null default '[]',
  mila text,
  spice text,
  plates jsonb not null default '{}',
  lunch jsonb not null default '{}',
  ing jsonb not null default '[]',
  primary key (household_id, id)
);

create table if not exists meal_ratings (
  household_id uuid not null default my_household() references households on delete cascade,
  meal_id text not null,
  date date not null,
  r int check (r in (-1,0,1)),
  t int check (t in (-1,0,1)),
  m int check (m in (-1,0,1)),
  note text,
  primary key (household_id, meal_id, date)
);

create table if not exists plan (
  household_id uuid primary key default my_household() references households on delete cascade,
  start_date date not null default '2026-11-02',
  default_takeout text not null default 'wed',
  takeout jsonb not null default '{}',
  staples jsonb not null default '{}'
);

-- Each phone's notification subscription (used by the notification sender)
create table if not exists push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  household_id uuid not null default my_household() references households on delete cascade,
  sub jsonb not null,
  prefs jsonb not null default '{"morning":true,"dinner":true,"shop":true,"events":true}',
  created_at timestamptz not null default now()
);

-- Security: each person only ever sees their own household -----------------
do $$
declare t text;
begin
  foreach t in array array['tasks','events','lists','list_items','meals','meal_ratings','plan'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists household_only on %I', t);
    execute format('create policy household_only on %I for all to authenticated using (household_id = my_household()) with check (household_id = my_household())', t);
  end loop;
end $$;

alter table households enable row level security;
drop policy if exists my_household_row on households;
create policy my_household_row on households for select to authenticated using (id = my_household());

alter table members enable row level security;
drop policy if exists household_members on members;
create policy household_members on members for select to authenticated using (household_id = my_household());

alter table invites enable row level security; -- no policies: only the join function reads it

alter table push_subs enable row level security;
drop policy if exists own_subs on push_subs;
create policy own_subs on push_subs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates between both phones
do $$
declare t text;
begin
  foreach t in array array['tasks','events','lists','list_items','meals','meal_ratings','plan'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
-- BrainMaid family app: your household and existing data. Run after schema.sql.
insert into households (id,name) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Eyden family') on conflict do nothing;
insert into invites (email,household_id,name,initials) values ('ryaneyden@gmail.com','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Ryan','R') on conflict (email) do nothing;
insert into invites (email,household_id,name,initials) values ('ryanjohneyden@gmail.com','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Ryan','R') on conflict (email) do nothing;
insert into invites (email,household_id,name,initials) values ('tkcraw@gmail.com','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Tamlyn','T') on conflict (email) do nothing;
insert into plan (household_id,start_date,default_takeout,takeout,staples) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','2026-11-02','wed','{}'::jsonb,'{"m": [{"a": "Meat", "n": "Biltong", "q": "500g"}, {"a": "Cupboard", "n": "Almonds or mixed nuts", "q": "1 bag"}, {"a": "Cupboard", "n": "Olive oil", "q": "1 bottle"}, {"a": "Sauces & spice", "n": "Garlic powder & paprika", "q": ""}, {"a": "Other", "n": "Freezer bags", "q": "1 box"}], "w": [{"a": "Dairy & eggs", "n": "Eggs", "q": "18"}, {"a": "Dairy & eggs", "n": "Greek yoghurt", "q": "1kg"}, {"a": "Dairy & eggs", "n": "Drinking yoghurt pouches", "q": "6"}, {"a": "Dairy & eggs", "n": "Milk", "q": "2L"}, {"a": "Dairy & eggs", "n": "Cheddar", "q": "1 block"}, {"a": "Fruit & veg", "n": "Soft fruit (bananas, berries, pears)", "q": ""}, {"a": "Bakery", "n": "Bread", "q": "1 loaf"}]}'::jsonb) on conflict (household_id) do nothing;
insert into lists (id,household_id,name,kind,sort) values ('b0000000-0000-4000-8000-000000000001','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Buy list','shop',0) on conflict do nothing;
insert into lists (id,household_id,name,kind,sort) values ('b0000000-0000-4000-8000-000000000002','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','House move','general',1) on conflict do nothing;
insert into lists (id,household_id,name,kind,sort) values ('b0000000-0000-4000-8000-000000000003','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Bills & admin','general',2) on conflict do nothing;
insert into lists (id,household_id,name,kind,sort) values ('b0000000-0000-4000-8000-000000000004','7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Mila','general',3) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w1-1',1,1,'Chicken strips & sweet potato wedges',18,'Air fryer','Chicken','["Toss the wedges and chicken with olive oil, garlic powder and mild paprika.", "Air-fry at 200°C for 12–14 min. Add the broccoli for the last 5 min.", "Plate Mila''s portion and pack her crèche box.", "Toss the rest of the chicken in peri-peri, lemon and a knob of butter for 60 sec."]'::jsonb,'Chicken strips, soft wedges and broccoli. Crèche box: extra strips and cheddar sticks.','Peri-peri, lemon and garlic butter.','{"ryan": "Big chicken portion, extra wedges and a toasted wrap.", "tamlyn": "Big chicken portion, double broccoli, light on wedges."}'::jsonb,'{"mila": "Chicken strips, soft wedges, cheddar sticks and fruit", "ryan": "Chicken strips and wedges rolled in a wrap", "tamlyn": "Chicken, broccoli and a few wedges"}'::jsonb,'[{"a": "Meat", "n": "Chicken mini fillets", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Sweet potato wedges (pre-cut)", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Broccoli florets", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Lemons", "q": "1", "t": "w"}, {"a": "Bakery", "n": "Tortilla wraps", "q": "1 pack", "t": "w"}, {"a": "Sauces & spice", "n": "Peri-peri sauce", "q": "1 bottle", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w1-2',1,2,'Hidden-veg beef mince fusilli',20,'Pan + pot','Beef','["Boil the fusilli for 10 min.", "Brown the mince with garlic, oregano and the grated courgette and carrot.", "Stir in the tinned tomatoes and 2 tbsp cream cheese. Simmer 5 min.", "Plate Mila''s portion, then stir chilli-garlic paste and smoked paprika into the rest."]'::jsonb,'Soft fusilli with the mild beef sauce. The same goes in her crèche box.','Chilli-garlic paste, smoked paprika and black pepper.','{"ryan": "Big bowl topped with cheddar.", "tamlyn": "Half portion of pasta mixed with 2 handfuls of spinach."}'::jsonb,'{"mila": "Soft fusilli with mild sauce, cucumber sticks", "ryan": "Beef fusilli topped with cheddar", "tamlyn": "Beef fusilli with extra spinach"}'::jsonb,'[{"a": "Meat", "n": "Beef mince (lean)", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Courgettes", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Carrots", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Baby spinach", "q": "1 bag", "t": "w"}, {"a": "Dairy & eggs", "n": "Cream cheese", "q": "1 tub", "t": "w"}, {"a": "Cupboard", "n": "Chopped tomatoes", "q": "1 tin", "t": "m"}, {"a": "Cupboard", "n": "Fusilli", "q": "400g", "t": "m"}, {"a": "Sauces & spice", "n": "Chilli-garlic paste", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w1-3',1,3,'Chicken fajita wraps',17,'Pan','Chicken','["Sear the chicken with the peppers, onion, garlic and mild cumin for 10 min.", "Make Mila a small chicken and cheese quesadilla and cut it into strips.", "Add chipotle, jalapeños and lime to the pan.", "Wrap with avocado and grated cheese."]'::jsonb,'Mild chicken and cheese quesadilla strips with avocado pieces. Same for crèche.','Chipotle, jalapeños and lime.','{"ryan": "Two loaded wraps.", "tamlyn": "One wrap with a tomato and avo salad."}'::jsonb,'{"mila": "Quesadilla strips and avo pieces", "ryan": "A chicken fajita wrap", "tamlyn": "Chicken over a tomato and avo salad"}'::jsonb,'[{"a": "Meat", "n": "Chicken breast strips", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Sliced peppers & onion", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Avocados", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Tomatoes", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Limes", "q": "1", "t": "w"}, {"a": "Bakery", "n": "Tortilla wraps", "q": "1 pack", "t": "w"}, {"a": "Dairy & eggs", "n": "Grated mozzarella", "q": "1 bag", "t": "w"}, {"a": "Sauces & spice", "n": "Chipotle spice", "q": "1", "t": "m"}, {"a": "Sauces & spice", "n": "Jalapeños", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w1-4',1,4,'Garlic steak strips, chips & green beans',19,'Air fryer + pan','Beef','["Air-fry the chips at 200°C for 15 min.", "Sear the steak with mushrooms, green beans and garlic-herb butter for 4 min.", "Plate Mila''s portion.", "Deglaze the pan with cracked pepper, crushed chilli and Worcestershire sauce."]'::jsonb,'Very finely diced steak (or 3 freezer meatballs, quartered), soft chips and buttered beans.','Cracked pepper, crushed chilli and Worcestershire.','{"ryan": "Double steak and chips.", "tamlyn": "Steak, double mushrooms and beans, small chips."}'::jsonb,'{"mila": "3 freezer meatballs (quartered), soft chips and beans", "ryan": "Steak strips and chips", "tamlyn": "Steak over salad leaves with mushrooms"}'::jsonb,'[{"a": "Meat", "n": "Sirloin or rump strips", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Potato chips/wedges (pre-cut)", "q": "600g", "t": "w"}, {"a": "Fruit & veg", "n": "Green beans", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Mushrooms", "q": "1 punnet", "t": "w"}, {"a": "Dairy & eggs", "n": "Butter", "q": "1 block", "t": "w"}, {"a": "Sauces & spice", "n": "Worcestershire sauce", "q": "1 bottle", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w2-1',2,1,'Butter chicken & basmati',20,'Pan + microwave','Chicken','["Sear the chicken with garlic, ginger and mild garam masala.", "Add 1 cup passata, ½ cup Greek yoghurt and the peas. Simmer 8 min.", "Microwave the rice pouches for 2 min.", "Plate Mila''s portion, then stir curry paste and fresh chilli into the rest for 2 min."]'::jsonb,'Mild butter chicken, peas and soft rice. Crèche box adds cucumber sticks.','Tikka or Cape Malay curry paste and fresh chilli.','{"ryan": "Full rice and a roti.", "tamlyn": "Half rice with steamed broccoli."}'::jsonb,'{"mila": "Mild butter chicken, rice and cucumber sticks", "ryan": "Butter chicken and rice", "tamlyn": "Butter chicken, broccoli and a little rice"}'::jsonb,'[{"a": "Meat", "n": "Diced chicken", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Broccoli florets", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Cucumber", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Ginger & garlic", "q": "", "t": "w"}, {"a": "Dairy & eggs", "n": "Greek yoghurt", "q": "1 tub", "t": "w"}, {"a": "Bakery", "n": "Rotis", "q": "1 pack", "t": "w"}, {"a": "Freezer", "n": "Frozen peas", "q": "1 bag", "t": "m"}, {"a": "Cupboard", "n": "Tomato passata", "q": "1 jar", "t": "m"}, {"a": "Cupboard", "n": "Basmati rice pouches", "q": "2", "t": "m"}, {"a": "Sauces & spice", "n": "Curry paste (tikka/Cape Malay)", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w2-2',2,2,'Smash burgers & mini meatballs',18,'Air fryer','Beef','["Season the mince with garlic and herbs.", "Roll 6 mini meatballs for Mila with grated courgette and cheese. Press 4 adult patties.", "Air-fry everything with the chips at 195°C for 12 min.", "Top the adult burgers with chipotle relish and jalapeños."]'::jsonb,'3 mini meatballs (quartered) and soft chips. Crèche: 3 more with fruit.','Chipotle or Prego relish and jalapeños.','{"ryan": "Double patty on a roll with chips.", "tamlyn": "Burger bowl with avo, tomato and slaw."}'::jsonb,'{"mila": "3 mini meatballs (quartered) and fruit", "ryan": "A burger patty in a roll", "tamlyn": "Burger bowl with salad and avo"}'::jsonb,'[{"a": "Meat", "n": "Beef mince (lean)", "q": "700g", "t": "m"}, {"a": "Fruit & veg", "n": "Courgettes", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Salad leaves", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Tomatoes", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Avocados", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Potato chips/wedges (pre-cut)", "q": "600g", "t": "w"}, {"a": "Bakery", "n": "Burger rolls", "q": "4", "t": "w"}, {"a": "Dairy & eggs", "n": "Cheddar", "q": "1 block", "t": "w"}, {"a": "Sauces & spice", "n": "Burger relish (chipotle/Prego)", "q": "1", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w2-3',2,3,'Peri-peri chicken flatbread pizzas',15,'Oven 220°C','Chicken','["Sear the chicken strips for 6 min, or shred a rotisserie chicken.", "Spread the flatbreads with tomato paste. Add chicken, corn and mozzarella.", "Bake at 220°C for 8–10 min.", "Keep one mild for Mila. Drizzle the rest with peri-peri oil, peppadews and chilli flakes."]'::jsonb,'Mild chicken, corn and cheese flatbread cut into soft strips. Same for crèche.','Peri-peri oil, peppadews and chilli flakes.','{"ryan": "1½ to 2 pizzas.", "tamlyn": "One pizza with a big rocket and avo salad."}'::jsonb,'{"mila": "Mild pizza strips", "ryan": "2 slices of flatbread pizza", "tamlyn": "1 slice of pizza with rocket salad"}'::jsonb,'[{"a": "Meat", "n": "Chicken breast strips", "q": "500g", "t": "m"}, {"a": "Fruit & veg", "n": "Rocket", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Avocados", "q": "1", "t": "w"}, {"a": "Bakery", "n": "Pizza flatbreads", "q": "4", "t": "w"}, {"a": "Dairy & eggs", "n": "Grated mozzarella", "q": "1 bag", "t": "w"}, {"a": "Cupboard", "n": "Tomato paste", "q": "1", "t": "m"}, {"a": "Cupboard", "n": "Sweetcorn", "q": "1 tin", "t": "m"}, {"a": "Sauces & spice", "n": "Peppadews", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w2-4',2,4,'Honey-soy beef noodle bowl',15,'Wok','Beef','["Cook the noodles.", "Stir-fry the beef with garlic and ginger for 5 min.", "Add the veg, a splash of soy, 1 tsp honey and the noodles. Toss for 5 min.", "Plate Mila''s portion, then toss chilli oil, sriracha and cashews through the rest."]'::jsonb,'Honey-soy beef, soft noodles cut short, and soft carrot and broccoli.','Crispy chilli oil, sriracha and cashews.','{"ryan": "Big bowl.", "tamlyn": "Double veg and beef, light on noodles."}'::jsonb,'{"mila": "Soft noodles cut short with honey-soy beef", "ryan": "Beef noodle bowl", "tamlyn": "Beef and veg, light on noodles"}'::jsonb,'[{"a": "Meat", "n": "Beef strips", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Stir-fry veg (pre-cut)", "q": "2 bags", "t": "w"}, {"a": "Fruit & veg", "n": "Ginger & garlic", "q": "", "t": "w"}, {"a": "Cupboard", "n": "Egg noodles", "q": "1 pack", "t": "m"}, {"a": "Sauces & spice", "n": "Soy sauce (low-sodium)", "q": "1 bottle", "t": "m"}, {"a": "Cupboard", "n": "Honey", "q": "1", "t": "m"}, {"a": "Cupboard", "n": "Cashews", "q": "1 bag", "t": "m"}, {"a": "Sauces & spice", "n": "Crispy chilli oil", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w3-1',3,1,'Creamy garlic chicken & spinach penne',19,'Deep pan','Chicken','["Boil the penne.", "Sear the chicken with garlic and Italian herbs.", "Add the penne, a splash of stock, ½ tub cream cheese and the spinach. Stir until creamy.", "Plate Mila''s portion, then add Cajun spice, chilli and sun-dried tomatoes."]'::jsonb,'Soft creamy chicken penne. Quarter any cherry tomatoes. Same for crèche.','Cajun spice, crushed chilli and sun-dried tomatoes.','{"ryan": "Full bowl.", "tamlyn": "Extra chicken and spinach, measured penne."}'::jsonb,'{"mila": "Creamy chicken penne, quartered cherry tomatoes", "ryan": "Cajun chicken penne", "tamlyn": "Chicken and spinach, small penne portion"}'::jsonb,'[{"a": "Meat", "n": "Diced chicken", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Baby spinach", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Cherry tomatoes", "q": "1 punnet", "t": "w"}, {"a": "Dairy & eggs", "n": "Cream cheese", "q": "1 tub", "t": "w"}, {"a": "Cupboard", "n": "Penne", "q": "350g", "t": "m"}, {"a": "Cupboard", "n": "Chicken stock", "q": "1", "t": "m"}, {"a": "Cupboard", "n": "Sun-dried tomatoes", "q": "1 jar", "t": "m"}, {"a": "Sauces & spice", "n": "Cajun spice", "q": "1", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w3-2',3,2,'Mexican beef & bean burrito bowls',18,'Pan + microwave','Beef','["Brown the mince with garlic and mild cumin.", "Add the black beans and corn. Cook 10 min.", "Microwave the rice pouches for 2 min.", "Plate Mila''s portion, then add taco spice, jalapeño salsa and chipotle mayo."]'::jsonb,'Mild beef, lightly squashed beans and corn, avo and cheddar.','Hot taco spice, jalapeño salsa and chipotle mayo.','{"ryan": "Loaded bowl with extra rice and tortilla chips.", "tamlyn": "Taco salad bowl, double greens, light rice."}'::jsonb,'{"mila": "Mild beef, squashed beans, cheddar and avo", "ryan": "Burrito bowl with rice", "tamlyn": "Taco salad bowl"}'::jsonb,'[{"a": "Meat", "n": "Beef mince (lean)", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Avocados", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Salad leaves", "q": "1 bag", "t": "w"}, {"a": "Dairy & eggs", "n": "Cheddar", "q": "1 block", "t": "w"}, {"a": "Cupboard", "n": "Black beans", "q": "1 tin", "t": "m"}, {"a": "Cupboard", "n": "Sweetcorn", "q": "1 tin", "t": "m"}, {"a": "Cupboard", "n": "Basmati rice pouches", "q": "2", "t": "m"}, {"a": "Cupboard", "n": "Tortilla chips", "q": "1 bag", "t": "m"}, {"a": "Sauces & spice", "n": "Taco spice", "q": "1", "t": "m"}, {"a": "Sauces & spice", "n": "Salsa", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w3-3',3,3,'Lemon-herb chicken thighs & butternut',20,'Air fryer','Chicken','["Toss the thighs, butternut and veg with lemon, olive oil and oregano.", "Air-fry at 200°C for 15 min.", "Dice Mila''s chicken small.", "Brush the adult thighs with harissa or peri-peri."]'::jsonb,'Diced chicken thigh (the softest cut), butternut and hummus to dip.','Harissa or hot peri-peri baste.','{"ryan": "Add warm pita or couscous.", "tamlyn": "Add extra roast courgette and peppers."}'::jsonb,'{"mila": "Diced chicken, butternut and hummus", "ryan": "Chicken thighs with pita", "tamlyn": "Chicken with roast veg"}'::jsonb,'[{"a": "Meat", "n": "Chicken thighs (boneless)", "q": "700g", "t": "m"}, {"a": "Fruit & veg", "n": "Butternut cubes (pre-cut)", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Courgettes", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Sliced peppers & onion", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Lemons", "q": "1", "t": "w"}, {"a": "Dairy & eggs", "n": "Hummus", "q": "1 tub", "t": "w"}, {"a": "Bakery", "n": "Pita breads", "q": "1 pack", "t": "w"}, {"a": "Sauces & spice", "n": "Harissa paste", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w3-4',3,4,'Prego steak & wedges',18,'Air fryer + pan','Beef','["Air-fry the wedges at 200°C for 15 min.", "Sauté onion and grated tomato with garlic and butter. Sear the steak in it.", "Plate Mila''s portion.", "Spike the sauce with peri-peri and a splash of red wine vinegar."]'::jsonb,'Soft wedges with the mild tomato-butter sauce, and finely diced beef (or egg and cheese).','Portuguese peri-peri and red wine vinegar.','{"ryan": "Prego roll and wedges.", "tamlyn": "Steak strips over salad, small wedges."}'::jsonb,'{"mila": "Wedges and finely diced beef (or egg and cheese)", "ryan": "A Prego steak roll", "tamlyn": "Steak strips over salad"}'::jsonb,'[{"a": "Meat", "n": "Sirloin or rump strips", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Potato chips/wedges (pre-cut)", "q": "600g", "t": "w"}, {"a": "Fruit & veg", "n": "Tomatoes", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Onions", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Salad leaves", "q": "1 bag", "t": "w"}, {"a": "Bakery", "n": "Portuguese rolls", "q": "4", "t": "w"}, {"a": "Dairy & eggs", "n": "Butter", "q": "1 block", "t": "w"}, {"a": "Sauces & spice", "n": "Peri-peri sauce", "q": "1 bottle", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w4-1',4,1,'Satay chicken & rice',16,'Air fryer + microwave','Chicken','["Air-fry the chicken at 200°C for 10 min.", "Whisk warm coconut milk, 2 tbsp peanut butter, a little soy and garlic into a sauce.", "Microwave the rice pouches for 2 min.", "Plate Mila''s portion, then add sweet chilli, lime and chilli oil to the adult sauce."]'::jsonb,'Chicken strips, soft rice, cucumber sticks and mild dip. Check the crèche''s nut rule before packing satay.','Sweet chilli, lime and crispy chilli oil.','{"ryan": "Full rice and extra sauce.", "tamlyn": "Cucumber and carrot salad, light rice."}'::jsonb,'{"mila": "Chicken strips, rice and cucumber (skip satay if crèche is nut-free)", "ryan": "Chicken, rice and satay sauce", "tamlyn": "Chicken with cucumber and carrot salad"}'::jsonb,'[{"a": "Meat", "n": "Chicken mini fillets", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Cucumber", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Carrots", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Limes", "q": "1", "t": "w"}, {"a": "Cupboard", "n": "Peanut butter", "q": "1 jar", "t": "m"}, {"a": "Cupboard", "n": "Coconut milk", "q": "1 tin", "t": "m"}, {"a": "Cupboard", "n": "Basmati rice pouches", "q": "2", "t": "m"}, {"a": "Sauces & spice", "n": "Sweet chilli sauce", "q": "1 bottle", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w4-2',4,2,'Italian meatballs & tomato pasta',20,'Air fryer + pot','Beef','["Roll beef and grated carrot meatballs. Air-fry at 200°C for 10 min.", "Boil the pasta meanwhile.", "Warm the passata with garlic and toss it through.", "Plate Mila''s portion, then simmer the adult meatballs in arrabbiata."]'::jsonb,'Mini meatballs (quartered) and pasta with cheese.','Spicy arrabbiata chilli-garlic sauce.','{"ryan": "Big bowl.", "tamlyn": "5 meatballs over spinach, light pasta."}'::jsonb,'{"mila": "Quartered meatballs and pasta with cheese", "ryan": "Meatball pasta", "tamlyn": "Meatballs over spinach"}'::jsonb,'[{"a": "Meat", "n": "Beef mince (lean)", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Carrots", "q": "1", "t": "w"}, {"a": "Fruit & veg", "n": "Baby spinach", "q": "1 bag", "t": "w"}, {"a": "Dairy & eggs", "n": "Grated mozzarella", "q": "1 bag", "t": "w"}, {"a": "Cupboard", "n": "Tomato passata", "q": "1 jar", "t": "m"}, {"a": "Cupboard", "n": "Spaghetti or penne", "q": "400g", "t": "m"}, {"a": "Sauces & spice", "n": "Chilli-garlic paste", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w4-3',4,3,'BBQ chicken & corn quesadillas',15,'Flat pan','Chicken','["Cook and shred the chicken (6 min).", "Fill the tortillas with chicken, corn, a little BBQ sauce and cheese.", "Pan-toast 2 min a side.", "Keep Mila''s plain. Add jalapeños and hot sauce inside the adult ones."]'::jsonb,'Cheesy chicken quesadilla in finger strips. Same for crèche.','Jalapeños, chipotle hot sauce and peppadews.','{"ryan": "Two quesadillas with avo.", "tamlyn": "One quesadilla with a big tomato, cucumber and avo salad."}'::jsonb,'{"mila": "Quesadilla finger strips", "ryan": "A BBQ chicken quesadilla", "tamlyn": "Half a quesadilla with salad"}'::jsonb,'[{"a": "Meat", "n": "Chicken breast strips", "q": "500g", "t": "m"}, {"a": "Fruit & veg", "n": "Avocados", "q": "2", "t": "w"}, {"a": "Fruit & veg", "n": "Cherry tomatoes", "q": "1 punnet", "t": "w"}, {"a": "Fruit & veg", "n": "Cucumber", "q": "1", "t": "w"}, {"a": "Bakery", "n": "Tortilla wraps", "q": "1 pack", "t": "w"}, {"a": "Dairy & eggs", "n": "Grated mozzarella", "q": "1 bag", "t": "w"}, {"a": "Cupboard", "n": "Sweetcorn", "q": "1 tin", "t": "m"}, {"a": "Sauces & spice", "n": "BBQ sauce", "q": "1 bottle", "t": "m"}, {"a": "Sauces & spice", "n": "Jalapeños", "q": "1 jar", "t": "m"}]'::jsonb) on conflict do nothing;
insert into meals (household_id,id,week,slot,title,mins,kit,protein,steps,mila,spice,plates,lunch,ing) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','w4-4',4,4,'Steakhouse sirloin, baby potatoes & mushrooms',18,'Air fryer + pan','Beef','["Air-fry the halved baby potatoes at 200°C for 14 min.", "Sear the steak and mushrooms in garlic-herb butter for 4–5 min. Rest the steak.", "Slice Mila''s steak very thin.", "Finish the adult steak with chilli-garlic butter and cracked pepper."]'::jsonb,'Soft potatoes (halved), mushrooms and very thin steak (or omelette fingers).','Chilli-garlic butter and cracked pepper.','{"ryan": "Steak and plenty of potatoes.", "tamlyn": "Steak, double mushrooms and spinach, 4 potatoes."}'::jsonb,'{"mila": "Halved potatoes and thin steak (or omelette fingers)", "ryan": "Steak and baby potatoes", "tamlyn": "Steak, mushrooms and spinach"}'::jsonb,'[{"a": "Meat", "n": "Sirloin or rump steak", "q": "600g", "t": "m"}, {"a": "Fruit & veg", "n": "Baby potatoes", "q": "1 bag", "t": "w"}, {"a": "Fruit & veg", "n": "Mushrooms", "q": "1 punnet", "t": "w"}, {"a": "Fruit & veg", "n": "Baby spinach", "q": "1 bag", "t": "w"}, {"a": "Dairy & eggs", "n": "Butter", "q": "1 block", "t": "w"}]'::jsonb) on conflict do nothing;
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Wedding anniversary with Tamlyn (1 Sep)','2027-09-01','both','yearly');
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Dad''s birthday (Desmond, 11 Jan)','2027-01-11','both','yearly');
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Derek''s birthday (26 May)','2027-05-26','both','yearly');
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Desrè''s birthday (1 Aug)','2027-08-01','both','yearly');
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Mila''s birthday (5 Sep)','2027-09-05','both','yearly');
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Mom''s birthday (Cilla, 28 Mar)','2027-03-28','both','yearly');
insert into events (household_id,title,date,who,repeat) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Tamlyn''s birthday (3 May)','2027-05-03','both','yearly');
insert into tasks (household_id,title,due,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Send George & Frank''s vet invoice to W Pet (claim WFS103986)','2026-11-14','R');
insert into tasks (household_id,title,due,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Add selected friends'' birthdays to calendar','2026-11-14','R');
insert into tasks (household_id,title,due,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Review last 50 WhatsApp contacts for birthdays','2026-11-14','R');
insert into tasks (household_id,title,due,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','Run the 4 slow-internet checks and send Claude the results','2026-11-14','R');
insert into list_items (household_id,list_id,name,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','b0000000-0000-4000-8000-000000000003','NordVPN expires mid-November - renew or let it lapse','R');
insert into list_items (household_id,list_id,name,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','b0000000-0000-4000-8000-000000000003','Find out what the R129.99 Apple ''Monthly'' subscription is (renews 21 Oct)','R');
insert into list_items (household_id,list_id,name,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','b0000000-0000-4000-8000-000000000003','Check if iCloud+ 50GB doubles up with Apple One (renews 28 Sep)','R');
insert into list_items (household_id,list_id,name,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','b0000000-0000-4000-8000-000000000003','Check the weekly Cleanup Pro charge (cdeyden Apple account)','R');
insert into list_items (household_id,list_id,name,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','b0000000-0000-4000-8000-000000000003','Review WeTransfer Ultimate - it bills every week','R');
insert into list_items (household_id,list_id,name,who) values ('7a1c0e5e-0b1d-4d55-9c3a-2f0e1b6d4e01','b0000000-0000-4000-8000-000000000003','Adobe renews 9 Oct - keep or change plan?','R');
