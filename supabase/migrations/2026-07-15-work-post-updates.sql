-- 既存のWORKS管理機能を更新する場合に、一度だけ実行してください。
-- 担当アーティスト・紹介文の任意入力・予約投稿・現場担当区分をまとめて有効にします。
-- 以前の更新SQLを未実行の場合も、このSQLだけで問題ありません。

alter table public.work_posts
  add column if not exists artists text check (char_length(artists) <= 240),
  add column if not exists publish_at timestamptz,
  add column if not exists role_type text check (role_type in ('artist_pa_operation', 'local_technical_support'));

alter table public.work_posts
  alter column description drop not null;

drop policy if exists "Anyone can read published work posts" on public.work_posts;

create policy "Anyone can read published work posts"
on public.work_posts for select
using (is_published = true and (publish_at is null or publish_at <= now()));

create index if not exists work_posts_publication_schedule_idx
on public.work_posts (publish_at)
where is_published = true;
