-- 対バンなど、1つの現場で「アーティストPA」と「乗り込みPA対応」の両方を担当する場合に対応します。
-- 一度だけ実行してください。既存の投稿と担当アーティストは保持されます。

alter table public.work_posts
  add column if not exists role_types text[] not null default '{}',
  add column if not exists operation_artists text check (char_length(operation_artists) <= 240),
  add column if not exists support_artists text check (char_length(support_artists) <= 240);

-- これまでの単一担当区分と担当アーティストを、新しい項目へ引き継ぎます。
update public.work_posts
set
  role_types = case
    when coalesce(array_length(role_types, 1), 0) = 0 and role_type is not null then array[role_type]
    else role_types
  end,
  operation_artists = coalesce(operation_artists, case when role_type = 'artist_pa_operation' then artists end),
  support_artists = coalesce(support_artists, case when role_type = 'local_technical_support' then artists end)
where role_type is not null;
