# BrainMaid

Ryan and Tamlyn's family hub: an installable phone app with four tabs (Today, Calendar, Lists, Meals) and a + button for adding anything. Data is shared live between both phones.

- **App:** plain HTML, CSS and JavaScript (`index.html`, `app.js`), hosted free on GitHub Pages.
- **Data and logins:** Supabase (free plan). Row-level security means only the people on the household's invite list can see its data.
- **Install on iPhone:** open the app's address in Safari, tap Share, then Add to Home Screen.

## Setup

1. Create a Supabase project, then run `supabase/setup.sql` once in its SQL Editor.
2. Invited emails are confirmed automatically by a database trigger, so no confirmation email is needed.
3. Put the project URL and the publishable (anon) key into `config.js`. Never put the secret key in this repository.
4. Turn on GitHub Pages for this repository (branch `main`, folder `/`).

`supabase/schema.sql` holds the tables and security rules. `supabase/seed.sql` holds the household, the invite list, the 16-meal rotation, family birthdays and starter lists.
