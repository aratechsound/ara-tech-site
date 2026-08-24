begin;

alter table public.work_posts
  drop constraint if exists work_posts_event_type_allowed;

alter table public.work_posts
  add constraint work_posts_event_type_allowed
    check (event_type in (
      'ライブ・コンサート',
      'クラブ・DJイベント',
      '祭り・地域イベント',
      'ダンス発表会・ショーケース',
      'ダンス・舞台公演',
      '企業・式典',
      '講演会・セミナー',
      '学校・文化イベント'
    ));

comment on column public.work_posts.event_type is
  'イベントそのものの正式種別。ダンススクール等の発表を主目的とする案件はダンス発表会・ショーケースに分類する。';

notify pgrst, 'reload schema';

commit;
