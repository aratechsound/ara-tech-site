-- schema.sqlの実行後、Supabase Dashboardで作成した最初の管理者アカウントを登録します。
-- YOUR_EMAIL@example.com を、ログインに使うメールアドレスへ置き換えて実行してください。

insert into public.work_admins (user_id)
select id from auth.users where email = 'YOUR_EMAIL@example.com'
on conflict (user_id) do nothing;
